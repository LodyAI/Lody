import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const eventLogPath = process.argv[2];
const sessions = new Set();
const mcpClients = new Map();

function record(event, details = {}) {
  appendFileSync(
    eventLogPath,
    `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details })}\n`,
    'utf8'
  );
}

const agent = acp
  .agent({ name: 'lody-mcp-catalog-e2e-agent' })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: {},
    agentInfo: { name: 'Lody MCP Catalog E2E Agent', version: '1' },
  }))
  .onRequest(acp.methods.agent.session.new, async ({ params }) => {
    const sessionId = `mcp-catalog-${randomUUID()}`;
    sessions.add(sessionId);
    record('session-new', { sessionId, mcpServers: params.mcpServers });
    const clients = [];
    for (const server of params.mcpServers ?? []) {
      if (!server.command) continue;
      const client = new Client({ name: 'lody-mcp-catalog-e2e-client', version: '1' });
      const env = Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value]));
      await client.connect(
        new StdioClientTransport({
          command: server.command,
          args: server.args ?? [],
          env: { ...process.env, ...env },
        })
      );
      await client.listTools();
      clients.push(client);
    }
    mcpClients.set(sessionId, clients);
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    if (!sessions.has(params.sessionId)) throw new Error(`Unknown session: ${params.sessionId}`);
    record('prompt-start', { sessionId: params.sessionId, mode: 'reply' });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Synthetic MCP selection received.' },
      },
    });
    record('prompt-end', {
      sessionId: params.sessionId,
      mode: 'reply',
      stopReason: 'end_turn',
    });
    return { stopReason: 'end_turn' };
  })
  .onRequest(acp.methods.agent.session.close, async ({ params }) => {
    await Promise.all((mcpClients.get(params.sessionId) ?? []).map((client) => client.close()));
    mcpClients.delete(params.sessionId);
    sessions.delete(params.sessionId);
    record('session-close', { sessionId: params.sessionId });
    return {};
  });

async function closeAndExit(signal) {
  record(signal);
  await Promise.all(
    [...mcpClients.values()].flatMap((clients) => clients.map((client) => client.close()))
  );
  process.exit(0);
}

process.on('SIGTERM', () => {
  void closeAndExit('sigterm');
});
process.on('SIGINT', () => {
  void closeAndExit('sigint');
});
record('process-start');
agent.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
