// Coreは人格・モデル解決を所有し、この層は実行権限を所有する。
export type ToolCall = { id: string; name: string; arguments: string };
export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };
export type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };
export type ModelReply = { content: string | null; toolCalls: ToolCall[] };
export interface ModelGateway {
  complete(input: { characterId: string; messages: Message[]; tools: ToolDefinition[] }, signal: AbortSignal): Promise<ModelReply>;
}
export interface ToolExecutor {
  definition: ToolDefinition;
  version: string;
  effect: 'read' | 'write';
  execute(args: Record<string, unknown>, context: { signal: AbortSignal; idempotencyKey: string }): Promise<unknown>;
}
export type AgentLimits = { maxTurns: number; maxToolCalls: number; maxCallsPerTool: number; maxDurationMs: number; maxTranscriptBytes: number };
export type AgentTask = { owner: string; runId: string; characterId: string; goal: string; allowedTools: string[]; limits?: Partial<AgentLimits> };
export type AgentResult = { state: 'completed' | 'failed' | 'stopped' | 'blocked'; final?: string; error?: string; turns: number; toolCalls: number };
export type Acquisition = { kind: 'acquired'; token: string } | { kind: 'busy' } | { kind: 'terminal'; result: AgentResult };
export type Effect = { kind: 'new' } | { kind: 'cached'; result: string } | { kind: 'uncertain' };
export interface RunStore {
  acquire(key: string, fingerprint: string): Acquisition;
  reserve(key: string, token: string, effectKey: string, callId: string, fingerprint: string): Effect;
  settle(key: string, token: string, effectKey: string, result: string): void;
  finish(key: string, token: string, result: AgentResult): void;
}
