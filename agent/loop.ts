import Ajv from 'ajv';
import { createHash } from 'node:crypto';
import type { AgentLimits, AgentResult, AgentTask, Message, ModelGateway, ModelReply, RunStore, ToolExecutor } from './contracts.ts';

const defaults: AgentLimits = { maxTurns: 4, maxToolCalls: 6, maxCallsPerTool: 3, maxDurationMs: 30000, maxTranscriptBytes: 65536 };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const v = value as Record<string, unknown>;
    const keys = Object.keys(v).sort();
    if (keys.some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) throw new Error('invalid_arguments');
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  throw new Error('invalid_json');
}
function bounded(text: unknown, bytes: number): string {
  if (typeof text !== 'string' || Buffer.byteLength(text) > bytes) throw new Error('output_limit');
  return text;
}
function check(signal: AbortSignal) { if (signal.aborted) throw new Error('stopped'); }
async function cancellable<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  check(signal);
  let stop!: () => void;
  const interrupted = new Promise<never>((_, reject) => { stop = () => reject(new Error('stopped')); signal.addEventListener('abort', stop, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => { check(signal); return fn(); }), interrupted]); }
  finally { signal.removeEventListener('abort', stop); }
}
function reply(value: ModelReply): ModelReply {
  if (!value || !Array.isArray(value.toolCalls) || value.toolCalls.length > 6) throw new Error('invalid_model_output');
  if (value.content !== null) bounded(value.content, 16384);
  const ids = new Set<string>();
  for (const call of value.toolCalls) {
    if (!call || typeof call.id !== 'string' || typeof call.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(call.id) || ids.has(call.id) || !/^[a-zA-Z0-9_-]{1,64}$/.test(call.name)) throw new Error('invalid_model_output');
    ids.add(call.id); bounded(call.arguments, 8192);
  }
  if (!value.toolCalls.length && !value.content?.trim()) throw new Error('invalid_model_output');
  return structuredClone(value);
}

export async function runAgent(task: AgentTask, deps: { gateway: ModelGateway; tools: ToolExecutor[]; store: RunStore }, external = new AbortController().signal): Promise<AgentResult> {
  task = structuredClone(task);
  for (const id of [task.owner, task.runId, task.characterId]) if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('invalid_identity');
  if (!bounded(task.goal, 4096).trim()) throw new Error('invalid_goal');
  const limits = { ...defaults, ...task.limits };
  for (const key of Object.keys(limits) as (keyof AgentLimits)[]) if (!(key in defaults) || !Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > defaults[key]) throw new Error('invalid_limits');
  const ajv = new Ajv({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
  const tools = new Map<string, { tool: ToolExecutor; validate: ReturnType<Ajv['compile']> }>();
  for (const tool of deps.tools) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.definition.name) || tools.has(tool.definition.name) || !tool.version || !['read', 'write'].includes(tool.effect)) throw new Error('invalid_tool_registration');
    tools.set(tool.definition.name, { tool, validate: ajv.compile(tool.definition.parameters) });
  }
  if (new Set(task.allowedTools).size !== task.allowedTools.length || task.allowedTools.some(name => !tools.has(name))) throw new Error('invalid_tool_policy');
  const definitions = task.allowedTools.map(name => structuredClone(tools.get(name)!.tool.definition));
  const identity = hash(canonical({ ...task, limits, tools: task.allowedTools.map(name => ({ ...tools.get(name)!.tool.definition, version: tools.get(name)!.tool.version, effect: tools.get(name)!.tool.effect })) }));
  const key = task.owner + '/' + task.runId;
  const acquired = deps.store.acquire(key, identity);
  if (acquired.kind === 'terminal') return acquired.result;
  if (acquired.kind === 'busy') return { state: 'blocked', error: 'run_in_progress_or_uncertain', turns: 0, toolCalls: 0 };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), limits.maxDurationMs);
  const signal = AbortSignal.any([external, controller.signal]);
  const deadline = performance.now() + limits.maxDurationMs;
  const checkDeadline = () => { if (performance.now() >= deadline) controller.abort(); check(signal); };
  const messages: Message[] = [{ role: 'user', content: task.goal }];
  const perTool = new Map<string, number>();
  let turns = 0, toolCalls = 0, result: AgentResult;
  try {
    while (turns < limits.maxTurns) {
      checkDeadline();
      if (Buffer.byteLength(canonical(messages)) > limits.maxTranscriptBytes) throw new Error('transcript_limit');
      const output = reply(await cancellable(() => { checkDeadline(); return deps.gateway.complete({ characterId: task.characterId, messages: structuredClone(messages), tools: structuredClone(definitions) }, signal); }, signal));
      checkDeadline(); turns++;
      if (Buffer.byteLength(canonical([...messages, { role: 'assistant', content: output.content, toolCalls: output.toolCalls }])) > limits.maxTranscriptBytes) throw new Error('transcript_limit');
      if (!output.toolCalls.length) {
        result = { state: 'completed', final: output.content!, turns, toolCalls };
        deps.store.finish(key, acquired.token, result); return result;
      }
      messages.push({ role: 'assistant', content: output.content, toolCalls: output.toolCalls });
      for (const call of output.toolCalls) {
        checkDeadline(); toolCalls++;
        const count = (perTool.get(call.name) || 0) + 1; perTool.set(call.name, count);
        if (toolCalls > limits.maxToolCalls || count > limits.maxCallsPerTool) throw new Error('tool_limit');
        const entry = tools.get(call.name);
        let response = JSON.stringify({ ok: false, error: 'tool_not_allowed' });
        if (entry && task.allowedTools.includes(call.name)) {
          let args: Record<string, unknown> | undefined;
          try { const value = JSON.parse(call.arguments); canonical(value); if (value && !Array.isArray(value) && typeof value === 'object' && entry.validate(value)) args = value; } catch { /* モデルの不正引数はtoolへ渡さない */ }
          response = JSON.stringify({ ok: false, error: 'invalid_arguments' });
          if (args) {
            const fingerprint = hash(canonical({ name: call.name, version: entry.tool.version, args }));
            const effectKey = hash(key + '/' + fingerprint + (entry.tool.effect === 'read' ? '/' + call.id : ''));
            const effect = deps.store.reserve(key, acquired.token, effectKey, call.id, fingerprint);
            checkDeadline();
            if (effect.kind === 'uncertain') throw new Error('effect_uncertain');
            if (effect.kind === 'cached') response = effect.result;
            else {
              try {
                const data = await cancellable(() => { checkDeadline(); return entry.tool.execute(args!, { signal, idempotencyKey: effectKey }); }, signal);
                checkDeadline(); response = bounded(canonical({ ok: true, data }), 16384);
              } catch (error) {
                if (signal.aborted || entry.tool.effect === 'write') throw new Error(signal.aborted ? 'stopped' : 'effect_uncertain');
                response = JSON.stringify({ ok: false, error: 'tool_failed' });
              }
              deps.store.settle(key, acquired.token, effectKey, response);
            }
          }
        }
        messages.push({ role: 'tool', toolCallId: call.id, content: response });
        if (Buffer.byteLength(canonical(messages)) > limits.maxTranscriptBytes) throw new Error('transcript_limit');
        checkDeadline();
      }
    }
    throw new Error('turn_limit');
  } catch (error) {
    const known = ['tool_limit', 'turn_limit', 'transcript_limit', 'invalid_model_output', 'output_limit', 'effect_uncertain', 'tool_call_conflict'];
    const message = error instanceof Error ? error.message : '';
    const code = signal.aborted ? 'stopped' : known.includes(message) ? message : 'gateway_or_store_failed';
    result = { state: code === 'stopped' ? 'stopped' : ['effect_uncertain', 'tool_call_conflict'].includes(code) ? 'blocked' : 'failed', error: code, turns, toolCalls };
    deps.store.finish(key, acquired.token, result); return result;
  } finally { clearTimeout(timer); }
}
