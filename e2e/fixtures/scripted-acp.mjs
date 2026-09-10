import { appendFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const eventLogPath = process.argv[2];
const sessions = new Map();
const pendingPrompts = new Map();

function record(event, details = {}) {
  if (!eventLogPath) return;
  appendFileSync(
    eventLogPath,
    `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details })}\n`,
    'utf8'
  );
}

function finishPending(sessionId, stopReason) {
  const pending = pendingPrompts.get(sessionId);
  if (!pending) return;
  pendingPrompts.delete(sessionId);
  pending.resolve(stopReason);
}

function promptText(prompt) {
  return prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
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

function writeSyntheticDiff(cwd, revision) {
  const lines = Array.from(
    { length: 1_500 },
    (_, index) => `export const syntheticLine${index + 1} = ${index + revision};`
  );
  writeFileSync(`${cwd}/synthetic-large-diff.ts`, `${lines.join('\n')}\n`, 'utf8');
}

const agent = acp
  .agent({ name: 'lody-scripted-e2e-agent' })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => {
    record('initialize');
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {},
      agentInfo: { name: 'Lody Scripted E2E Agent', version: '1' },
    };
  })
  .onRequest(acp.methods.agent.session.new, async ({ params }) => {
    const sessionId = `scripted-${randomUUID()}`;
    sessions.set(sessionId, { cwd: params.cwd, revision: 0 });
    record('session-new', { sessionId });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client, signal }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown scripted session: ${params.sessionId}`);
    const text = promptText(params.prompt);
    const mode = text.includes('You generate titles for coding sessions.')
      ? 'title'
      : text.includes('[SCOUT:HOLD]')
        ? 'hold'
        : text.includes('[SCOUT:DIFF]')
          ? 'diff'
          : 'reply';
    record('prompt-start', { sessionId: params.sessionId, mode });

    if (mode === 'diff') {
      session.revision += 1;
      writeSyntheticDiff(session.cwd, session.revision);
      await emitText(
        client,
        params.sessionId,
        `Synthetic diff revision ${session.revision} ready.`
      );
      record('prompt-end', { sessionId: params.sessionId, mode, stopReason: 'end_turn' });
      return { stopReason: 'end_turn' };
    }

    if (mode === 'title') {
      await emitText(client, params.sessionId, 'Synthetic session title');
      record('prompt-end', { sessionId: params.sessionId, mode, stopReason: 'end_turn' });
      return { stopReason: 'end_turn' };
    }

    await emitText(client, params.sessionId, 'Synthetic response started.');
    if (mode !== 'hold') {
      await emitText(client, params.sessionId, ' Synthetic response complete.');
      record('prompt-end', { sessionId: params.sessionId, mode, stopReason: 'end_turn' });
      return { stopReason: 'end_turn' };
    }

    return await new Promise((resolve) => {
      const finish = (stopReason) => {
        signal.removeEventListener('abort', onAbort);
        record('prompt-end', { sessionId: params.sessionId, mode, stopReason });
        resolve({ stopReason });
      };
      const onAbort = () => finish('cancelled');
      pendingPrompts.set(params.sessionId, { resolve: finish });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  })
  .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
    record('session-cancel', { sessionId: params.sessionId });
    finishPending(params.sessionId, 'cancelled');
  })
  .onRequest(acp.methods.agent.session.close, async ({ params }) => {
    finishPending(params.sessionId, 'cancelled');
    sessions.delete(params.sessionId);
    record('session-close', { sessionId: params.sessionId });
    return {};
  });

process.on('SIGTERM', () => {
  record('sigterm');
  process.exit(0);
});
process.on('SIGINT', () => {
  record('sigint');
  process.exit(0);
});
record('process-start');
agent.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
