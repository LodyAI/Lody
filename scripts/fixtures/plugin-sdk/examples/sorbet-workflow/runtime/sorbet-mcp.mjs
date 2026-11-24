#!/usr/bin/env node
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

const notes = new Map();
await serve((method, params) => {
  if (method === 'initialize')
    return {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'sorbet-memory', version: '1.0.0' },
    };
  if (method === 'ping') return {};
  if (method === 'tools/list')
    return {
      tools: [
        {
          name: 'remember',
          description: 'Store a named note for this process.',
          inputSchema: {
            type: 'object',
            properties: { key: { type: 'string' }, text: { type: 'string' } },
            required: ['key', 'text'],
          },
        },
        {
          name: 'recall',
          description: 'Recall a named note.',
          inputSchema: {
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
          },
        },
      ],
    };
  if (method === 'tools/call') {
    const { key, text } = params.arguments ?? {};
    if (typeof key !== 'string') throw Error();
    if (params.name === 'remember' && typeof text === 'string') notes.set(key, text);
    else if (params.name !== 'recall') throw Error();
    return { content: [{ type: 'text', text: notes.get(key) ?? 'No note found.' }] };
  }
});
