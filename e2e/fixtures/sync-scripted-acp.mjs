// Only the external ACP provider is simulated. Each prompt has a file barrier so
// both desktop replicas must observe streaming before the provider completes.
import { appendFileSync, existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const [eventLog, signals] = process.argv.slice(2);
const sessions = new Set();
function record(event, details) {
  appendFileSync(eventLog, `${JSON.stringify({ event, pid: process.pid, ...details })}\n`);
}
function released(token, signal) {
  const path = join(signals, token);
  if (signal.aborted) return Promise.reject(signal.reason);
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      watcher.close();
      signal.removeEventListener('abort', abort);
    };
    const check = () => {
      if (existsSync(path)) {
        cleanup();
        resolve();
      }
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const watcher = watch(signals, check);
    watcher.once('error', (error) => {
      cleanup();
      reject(error);
    });
    signal.addEventListener('abort', abort, { once: true });
    check();
    if (signal.aborted) abort();
  });
}
async function text(client, sessionId, value) {
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } },
  });
}
acp
  .agent({ name: 'lody-sync-e2e' })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: {},
    agentInfo: { name: 'Lody Sync E2E', version: '1' },
  }))
  .onRequest(acp.methods.agent.session.new, async () => {
    const sessionId = randomUUID();
    sessions.add(sessionId);
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client, signal }) => {
    if (!sessions.has(params.sessionId)) throw new Error('Unknown synthetic session');
    const prompt = params.prompt
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    if (prompt.includes('You generate titles for coding sessions.')) {
      await text(client, params.sessionId, 'Synthetic sync conversation');
      return { stopReason: 'end_turn' };
    }
    const token = /\[SYNC:([a-zA-Z0-9-]+)\]/u.exec(prompt)?.[1];
    if (!token) throw new Error('Missing synthetic sync token');
    record('start', { token, sessionId: params.sessionId });
    await text(client, params.sessionId, `SYNC_STARTED_${token}`);
    try {
      await released(token, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      record('cancelled', { token, sessionId: params.sessionId });
      return { stopReason: 'cancelled' };
    }
    await text(client, params.sessionId, `\n\nSYNC_REPLY_${token}`);
    record('complete', { token, sessionId: params.sessionId });
    return { stopReason: 'end_turn' };
  })
  .onRequest(acp.methods.agent.session.close, async ({ params }) => {
    sessions.delete(params.sessionId);
    return {};
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
