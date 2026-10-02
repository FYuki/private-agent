import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CoreGateway } from '../agent/core-gateway.ts';
test('Core wire contract carries character identity and tool results without physical model', async () => {
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.url, '/v1/character/completions'); assert.equal(body.character_id, 'alice'); assert.equal(body.model, undefined);
    assert.equal(body.messages[1].tool_call_id, 'call'); assert.equal(body.stream, false);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try { const gateway = new CoreGateway(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    const result = await gateway.complete({ characterId: 'alice', messages: [{ role: 'user', content: 'fixture' }, { role: 'tool', toolCallId: 'call', content: '{}' }], tools: [] }, new AbortController().signal);
    assert.equal(result.content, 'done');
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
test('Core redirects and oversized responses are rejected', async () => {
  let forwarded = 0, oversized = false;
  const server = createServer((req, res) => {
    if (req.url === '/target') { forwarded++; res.end('{}'); }
    else if (oversized) res.end('x'.repeat(65537));
    else { res.writeHead(307, { location: '/target' }); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try { const gateway = new CoreGateway(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    await assert.rejects(gateway.complete({ characterId: 'alice', messages: [], tools: [] }, new AbortController().signal)); assert.equal(forwarded, 0);
    oversized = true;
    await assert.rejects(gateway.complete({ characterId: 'alice', messages: [], tools: [] }, new AbortController().signal));
  } finally { await new Promise<void>(r => server.close(() => r())); }
  assert.throws(() => new CoreGateway('https://example.com/v1'));
});
