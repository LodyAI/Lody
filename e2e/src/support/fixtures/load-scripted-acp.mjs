import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const eventLogPath = process.argv[2];
const sessions = new Map();
const MAX_BODY_BYTES = 256 * 1024;

function record(event, details = {}) {
  if (!eventLogPath) return;
  appendFileSync(
    eventLogPath,
    `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details })}\n`,
    'utf8'
  );
}

function promptText(prompt) {
  return prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function loadSize(prompt) {
  const match = /\[LOAD:(\d+)\]/u.exec(prompt);
  if (!match) return 1 * 1024;
  return Math.max(1, Math.min(MAX_BODY_BYTES, Number(match[1])));
}

function buildBody(size, sequence) {
  const marker = `LOAD_BODY_${size}_${sequence}`;
  const line = `Synthetic heavy-load content ${sequence}: ${marker}. `;
  let body = `${marker}\n`;
  while (Buffer.byteLength(body, 'utf8') < size) body += line;
  return `${body.slice(0, size)}\n${marker}`;
}

async function emitText(client, sessionId, text) {
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    },
  });
}

const agent = acp
  .agent({ name: 'lody-heavy-load-agent' })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: {},
    agentInfo: { name: 'Lody Heavy Load Agent', version: '1' },
  }))
  .onRequest(acp.methods.agent.session.new, async ({ params }) => {
    const sessionId = `load-${randomUUID()}`;
    sessions.set(sessionId, { cwd: params.cwd, sequence: 0 });
    record('session-new', { sessionId });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown heavy-load session: ${params.sessionId}`);
    const prompt = promptText(params.prompt);
    if (prompt.includes('You generate titles for coding sessions.')) {
      await emitText(client, params.sessionId, 'Synthetic heavy-load session');
      record('prompt-end', { sessionId: params.sessionId, mode: 'title' });
      return { stopReason: 'end_turn' };
    }

    const size = loadSize(prompt);
    session.sequence += 1;
    const marker = `LOAD_BODY_${size}_${session.sequence}`;
    record('prompt-start', { sessionId: params.sessionId, mode: 'load', size, marker });
    await emitText(client, params.sessionId, 'Synthetic response started.');
    await emitText(client, params.sessionId, `\n${buildBody(size, session.sequence)}\n`);
    await emitText(client, params.sessionId, 'Synthetic response complete.');
    record('prompt-end', { sessionId: params.sessionId, mode: 'load', size, marker });
    return { stopReason: 'end_turn' };
  })
  .onRequest(acp.methods.agent.session.close, async ({ params }) => {
    sessions.delete(params.sessionId);
    record('session-close', { sessionId: params.sessionId });
    return {};
  });

record('process-start');
agent.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
