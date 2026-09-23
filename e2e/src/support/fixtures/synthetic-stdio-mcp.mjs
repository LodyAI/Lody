import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const eventLogPath = process.argv[2];

function record(event) {
  appendFileSync(
    eventLogPath,
    `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event })}\n`,
    'utf8'
  );
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

record('process-start');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'synthetic-workspace-mcp', version: '1' },
    });
  } else if (request.method === 'tools/list') {
    respond(request.id, { tools: [] });
  }
});

process.on('exit', () => record('process-exit'));
