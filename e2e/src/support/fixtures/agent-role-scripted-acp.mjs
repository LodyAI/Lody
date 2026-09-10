import { appendFileSync, existsSync, watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, basename } from 'node:path';
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
  .agent({ name: 'lody-agent-role-e2e-agent' })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: {},
    agentInfo: { name: 'Lody Agent Role E2E Agent', version: '1' },
  }))
  .onRequest(acp.methods.agent.session.new, async () => {
    const sessionId = `agent-role-${randomUUID()}`;
    sessions.add(sessionId);
    record('session-new', { sessionId });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    if (!sessions.has(params.sessionId)) throw new Error(`Unknown session: ${params.sessionId}`);
    const prompt = params.prompt
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    record('prompt-start', { sessionId: params.sessionId, prompt });
    await waitForReleaseSignal();
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Synthetic role-bound review complete.' },
      },
    });
    record('prompt-end', { sessionId: params.sessionId, prompt, stopReason: 'end_turn' });
    return { stopReason: 'end_turn' };
  })
  .onNotification(acp.methods.agent.session.cancel, async () => {})
  .onRequest(acp.methods.agent.session.close, async ({ params }) => {
    sessions.delete(params.sessionId);
    record('session-close', { sessionId: params.sessionId });
    return {};
  });

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
record('process-start');
agent.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
