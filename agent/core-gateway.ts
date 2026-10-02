import OpenAI from 'openai';
import type { ModelGateway, ModelReply } from './contracts.ts';

// 初期接続は明示的に設定したローカルCoreだけ。環境のAPIキーは参照しない。
export class CoreGateway implements ModelGateway {
  private client: OpenAI;
  constructor(baseURL: string) {
    const url = new URL(baseURL);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/v1') throw new Error('invalid_core_endpoint');
    this.client = new OpenAI({ baseURL, apiKey: 'local-core-no-credential', maxRetries: 0, timeout: 30000,
      fetch: async (request, options) => {
        const response = await fetch(request, { ...options, redirect: 'error' });
        const reader = response.body?.getReader();
        if (!reader) return response;
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const item = await reader.read(); if (item.done) break;
            size += item.value.byteLength;
            if (size > 65536) throw new Error('core_response_limit');
            chunks.push(item.value);
          }
        } finally { await reader.cancel(); }
        return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
      },
    });
  }
  async complete(input: Parameters<ModelGateway['complete']>[0], signal: AbortSignal): Promise<ModelReply> {
    const messages = input.messages.map(m => m.role === 'tool' ? { role: m.role, content: m.content, tool_call_id: m.toolCallId } : m.role === 'assistant' ? {
      role: m.role, content: m.content, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {})
    } : m);
    const response = await this.client.post<OpenAI.Chat.Completions.ChatCompletion>('/character/completions', {
      body: { character_id: input.characterId, messages, stream: false, max_tokens: 1024,
        ...(input.tools.length ? { tools: input.tools.map(t => ({ type: 'function', function: t })), tool_choice: 'auto' } : {}) },
      signal,
    });
    const message = response.choices?.[0]?.message;
    if (!message || response.choices.length !== 1 || !['stop', 'tool_calls'].includes(response.choices[0].finish_reason)) throw new Error('invalid_core_response');
    return { content: message.content ?? null, toolCalls: (message.tool_calls || []).map(c => {
      if (c.type !== 'function') throw new Error('invalid_core_response');
      return { id: c.id, name: c.function.name, arguments: c.function.arguments };
    }) };
  }
}
