import { appendFileSync, existsSync, watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const eventLogPath = process.argv[2];
const releaseSignalPath = process.argv[3];
const sessions = new Set();

function record(event, details = {}) {
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

function modeFor(text) {
  if (text.includes('You generate titles for coding sessions.')) return 'title';
  if (text.includes('[LODY-QUEUE-001:HOLD]')) return 'hold';
  if (text.includes('[LODY-QUEUE-001:CANCELLED]')) return 'cancelled';
  if (text.includes('[LODY-QUEUE-001:RETAINED]')) return 'retained';
  return 'other';
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

function waitForReleaseSignal() {
  if (existsSync(releaseSignalPath)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(releaseSignalPath), (event, filename) => {
      if (event !== 'rename' || filename !== basename(releaseSignalPath)) return;
      if (!existsSync(releaseSignalPath)) return;
      watcher.close();
      resolve();
    });
    watcher.once('error', reject);
    if (existsSync(releaseSignalPath)) {
      watcher.close();
      resolve();
    }
  });
}

const agent = acp
  .agent({ name: 'lody-queue-e2e-agent' })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: {},
    agentInfo: { name: 'Lody Queue E2E Agent', version: '1' },
  }))
  .onRequest(acp.methods.agent.session.new, async () => {
    const sessionId = `queue-${randomUUID()}`;
    sessions.add(sessionId);
    record('session-new', { sessionId });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    if (!sessions.has(params.sessionId))
      throw new Error(`Unknown queue session: ${params.sessionId}`);
    const mode = modeFor(promptText(params.prompt));
    record('prompt-start', { sessionId: params.sessionId, mode });

    if (mode === 'hold') {
      await emitText(client, params.sessionId, 'Synthetic queue hold started.');
      await waitForReleaseSignal();
      record('prompt-end', { sessionId: params.sessionId, mode, stopReason: 'end_turn' });
      return { stopReason: 'end_turn' };
    }

    const response =
      mode === 'retained'
        ? 'Synthetic retained queue message complete.'
        : 'Synthetic response complete.';
    await emitText(client, params.sessionId, response);
    record('prompt-end', { sessionId: params.sessionId, mode, stopReason: 'end_turn' });
    return { stopReason: 'end_turn' };
  })
  .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
    record('session-cancel', { sessionId: params.sessionId });
  })
  .onRequest(acp.methods.agent.session.close, async ({ params }) => {
    sessions.delete(params.sessionId);
    record('session-close', { sessionId: params.sessionId });
    return {};
  });

record('process-start');
agent.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
