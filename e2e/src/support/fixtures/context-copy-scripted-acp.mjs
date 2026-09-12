import { appendFileSync, existsSync, watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const eventLogPath = process.argv[2];
const releasePrimaryStreamSignalPath = process.argv[3];
const sessions = new Set();
const pendingStreams = new Map();
const streamModes = new Map();

const prompts = {
  first: 'CONTEXT-PRIMARY-USER-RICH',
  second: 'CONTEXT-PRIMARY-LATER-USER',
  'primary-stream': 'CONTEXT-PRIMARY-STREAM',
  'isolated-stream': 'CONTEXT-ISOLATED-CANCEL',
};

const responses = {
  first:
    "CONTEXT-PRIMARY-ASSISTANT-RICH\n\n### Preserve this answer\n\n```ts\nexport const retainedAssistantCode = 'primary-assistant';\n```",
  second: 'CONTEXT-PRIMARY-LATER-ASSISTANT: this must not be in the first prefix.',
};

function record(event, details = {}) {
  appendFileSync(
    eventLogPath,
    `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`,
    'utf8'
  );
}

function promptText(prompt) {
  return prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function classifyPrompt(text) {
  if (text.includes('You generate titles for coding sessions.')) return 'title';
  return Object.entries(prompts).find(([, prompt]) => text.includes(prompt))?.[0] ?? 'unknown';
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

function waitForPrimaryReleaseOrCancel(sessionId) {
  if (existsSync(releasePrimaryStreamSignalPath)) return Promise.resolve('released');
  return new Promise((resolve, reject) => {
    const release = () => {
      watcher.close();
      pendingStreams.delete(sessionId);
      resolve('released');
    };
    const watcher = watch(dirname(releasePrimaryStreamSignalPath), (event, filename) => {
      if (event !== 'rename' || filename !== basename(releasePrimaryStreamSignalPath)) return;
      if (!existsSync(releasePrimaryStreamSignalPath)) return;
      release();
    });
    const cancel = () => {
      watcher.close();
      pendingStreams.delete(sessionId);
      resolve('cancelled');
    };
    pendingStreams.set(sessionId, cancel);
    watcher.once('error', reject);
    if (existsSync(releasePrimaryStreamSignalPath)) release();
  });
}

function waitForCancel(sessionId) {
  return new Promise((resolve) => {
    pendingStreams.set(sessionId, () => {
      pendingStreams.delete(sessionId);
      resolve('cancelled');
    });
  });
}

const agent = acp
  .agent({ name: 'lody-context-copy-e2e-agent' })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => ({
    protocolVersion: params.protocolVersion,
    // This fixture deliberately lacks the optional native ACP fork capability.
    agentCapabilities: {},
    agentInfo: { name: 'Lody Context Copy E2E Agent', version: '2' },
  }))
  .onRequest(acp.methods.agent.session.new, async () => {
    const sessionId = `context-copy-${randomUUID()}`;
    sessions.add(sessionId);
    record('session-new', { sessionId });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    if (!sessions.has(params.sessionId)) throw new Error(`Unknown session: ${params.sessionId}`);
    const text = promptText(params.prompt);
    const mode = classifyPrompt(text);
    record('prompt-start', { sessionId: params.sessionId, mode, promptText: text });

    if (mode === 'title') {
      await emitText(client, params.sessionId, 'Context copy journey');
      record('prompt-end', { sessionId: params.sessionId, mode, stopReason: 'end_turn' });
      return { stopReason: 'end_turn' };
    }
    if (mode === 'first' || mode === 'second') {
      await emitText(client, params.sessionId, responses[mode]);
      record('prompt-end', { sessionId: params.sessionId, mode, stopReason: 'end_turn' });
      return { stopReason: 'end_turn' };
    }
    if (mode === 'primary-stream') {
      streamModes.set(params.sessionId, mode);
      await emitText(
        client,
        params.sessionId,
        'CONTEXT-PRIMARY-STREAM-PREFIX: visible while generating.'
      );
      record('stream-ready', { sessionId: params.sessionId, mode });
      const result = await waitForPrimaryReleaseOrCancel(params.sessionId);
      if (result === 'released') {
        await emitText(
          client,
          params.sessionId,
          'CONTEXT-PRIMARY-STREAM-TAIL: available only after explicit release.'
        );
      }
      const stopReason = result === 'released' ? 'end_turn' : 'cancelled';
      record('prompt-end', { sessionId: params.sessionId, mode, stopReason });
      return { stopReason };
    }
    if (mode === 'isolated-stream') {
      streamModes.set(params.sessionId, mode);
      await emitText(
        client,
        params.sessionId,
        'CONTEXT-ISOLATED-PREFIX: visible before cancellation.'
      );
      record('stream-ready', { sessionId: params.sessionId, mode });
      await waitForCancel(params.sessionId);
      record('prompt-end', { sessionId: params.sessionId, mode, stopReason: 'cancelled' });
      return { stopReason: 'cancelled' };
    }
    throw new Error(`Unexpected context copy prompt: ${text}`);
  })
  .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
    record('session-cancel', {
      sessionId: params.sessionId,
      mode: streamModes.get(params.sessionId),
    });
    pendingStreams.get(params.sessionId)?.();
  })
  .onRequest(acp.methods.agent.session.close, async ({ params }) => {
    pendingStreams.get(params.sessionId)?.();
    streamModes.delete(params.sessionId);
    sessions.delete(params.sessionId);
    record('session-close', { sessionId: params.sessionId });
    return {};
  });

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
agent.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
