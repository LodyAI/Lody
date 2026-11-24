#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
function send(frame) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
}
async function serve(handle) {
  for await (const line of createInterface({ input: process.stdin })) {
    let request;
    try {
      request = JSON.parse(line);
      if (request.id === undefined) continue;
      const result = await handle(request.method, request.params ?? {});
      if (result === undefined)
        send({ id: request.id, error: { code: -32601, message: 'Unknown method' } });
      else send({ id: request.id, result });
    } catch {
      send({ id: request?.id ?? null, error: { code: -32602, message: 'Invalid request' } });
    }
  }
}

const sessions = new Set();
await serve((method, params) => {
  if (method === 'initialize')
    return {
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: 'sorbet-reference', version: '1.0.0' },
    };
  if (method === 'session/new') {
    const sessionId = randomUUID();
    sessions.add(sessionId);
    return { sessionId };
  }
  if (method === 'session/prompt') {
    if (!sessions.has(params.sessionId)) throw Error();
    send({
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Reference workflow turn received.' },
        },
      },
    });
    return { stopReason: 'end_turn' };
  }
});
