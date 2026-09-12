import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const eventLogPath = process.argv[2];
const variant = process.argv[3];
const sessions = new Set();
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
  .onRequest(acp.methods.agent.session.new, async () => {
    const sessionId = `agent-provider-${randomUUID()}`;
    sessions.add(sessionId);
    record('session-new', { sessionId });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    if (!sessions.has(params.sessionId)) throw new Error(`Unknown session: ${params.sessionId}`);
    const prompt = promptText(params.prompt);
    record('prompt-start', { sessionId: params.sessionId, prompt });
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
    sessions.delete(params.sessionId);
    record('session-close', { sessionId: params.sessionId });
    return {};
  });

record('process-start');
agent.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
