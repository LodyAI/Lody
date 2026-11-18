import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const eventLogPath = process.argv[2];
const variant = process.argv[3];
const sessions = new Set();
const previewTargetFile = process.argv[4];
const previewClients = new Map();
const responseText = `Synthetic ${variant} Agent Provider lifecycle complete.`;

function record(event, details = {}) {
  appendFileSync(
    eventLogPath,
    `${JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, variant, ...details })}\n`,
    'utf8'
  );
}

function promptText(prompt) {
  return prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

const agent = acp
  .agent({ name: 'lody-agent-provider-lifecycle-e2e-agent' })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: {},
    agentInfo: { name: `Lody ${variant} Agent Provider Lifecycle E2E Agent`, version: '1' },
  }))
  .onRequest(acp.methods.agent.session.new, async ({ params }) => {
    const sessionId = `agent-provider-${randomUUID()}`;
    sessions.add(sessionId);
    if (previewTargetFile && process.env.LODY_TITLE_AGENT !== '1') {
      for (const server of params.mcpServers ?? []) {
        if (!server.command) continue;
        const client = new Client({ name: 'lody-preview-migration-e2e', version: '1' });
        await client.connect(
          new StdioClientTransport({
            command: server.command,
            args: server.args ?? [],
            env: {
              ...process.env,
              ...Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])),
            },
          })
        );
        const tools = await client.listTools();
        if (tools.tools.some((tool) => tool.name === 'lody_report_preview_candidate')) {
          previewClients.set(sessionId, client);
          break;
        }
        await client.close();
      }
      // Provider capability probes create a Session without granting MCP tools.
      // Only an actual preview turn requires and consumes the granted tool.
    }
    record('session-new', { sessionId });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    if (!sessions.has(params.sessionId)) throw new Error(`Unknown session: ${params.sessionId}`);
    const prompt = promptText(params.prompt);
    record('prompt-start', { sessionId: params.sessionId, prompt });
    if (previewTargetFile && process.env.LODY_TITLE_AGENT !== '1') {
      if (!previewClients.has(params.sessionId))
        throw new Error('Actual Lody preview MCP tool unavailable for preview turn');
      const result = await previewClients.get(params.sessionId).callTool({
        name: 'lody_report_preview_candidate',
        arguments: JSON.parse(readFileSync(previewTargetFile, 'utf8')),
      });
      if (result.isError) throw new Error('Actual preview candidate report rejected');
      record('preview-reported', { sessionId: params.sessionId });
    }
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: responseText },
      },
    });
    record('prompt-end', { sessionId: params.sessionId, prompt });
    return { stopReason: 'end_turn' };
  })
  .onRequest(acp.methods.agent.session.close, async ({ params }) => {
    await previewClients.get(params.sessionId)?.close();
    previewClients.delete(params.sessionId);
    sessions.delete(params.sessionId);
    record('session-close', { sessionId: params.sessionId });
    return {};
  });

for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    void Promise.all([...previewClients.values()].map((client) => client.close())).then(() =>
      process.exit(0)
    );
  });
record('process-start');
agent.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
