import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

// Synthetic model for LODY-TURN-001..004. Every prompt names its behavior with a
// marker so the event log proves which prompts reached the provider, in which
// process, and how many times.
const eventLogPath = process.argv[2];
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

const HOLD_OUTPUT = 'Synthetic long-running work started.';

function modeFor(text) {
  if (text.includes('You generate titles for coding sessions.')) return 'title';
  // A replacement process receives prior history in its prompt; the newest
  // marker is the user's current message.
  const markers = [...text.matchAll(/\[LODY-TURN-00\d:([A-Z-]+)\]/gu)];
  const newest = markers.length > 0 ? markers[markers.length - 1][1].toLowerCase() : null;
  // The user's hold request can never contain this agent's own hold output, so a
  // prompt carrying it is Lody resuming the interrupted work with replayed history.
  // A prompt with no journey marker at all is Lody's own continuation message.
  if (newest === 'hold' && text.includes(HOLD_OUTPUT)) return 'continue';
  return newest ?? 'continue';
}

async function emitText(client, sessionId, text) {
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });
}

function flushStdout() {
  return new Promise((resolve) => process.stdout.write('', () => resolve()));
}

const replies = {
  continue: 'Synthetic work resumed after restart.',
  recover: 'Synthetic recovery reply.',
  before: 'Synthetic reply before restart.',
  after: 'Synthetic reply after restart.',
};

const agent = acp
  .agent({ name: 'lody-turn-lifecycle-e2e-agent' })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: {},
    agentInfo: { name: 'Lody Turn Lifecycle E2E Agent', version: '1' },
  }))
  .onRequest(acp.methods.agent.session.new, async () => {
    const sessionId = `turn-${randomUUID()}`;
    sessions.add(sessionId);
    record('session-new', { sessionId });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    if (!sessions.has(params.sessionId))
      throw new Error(`Unknown turn-lifecycle session: ${params.sessionId}`);
    const { sessionId } = params;
    const mode = modeFor(promptText(params.prompt));
    record('prompt-start', { sessionId, mode });

    if (mode === 'permission') {
      const toolCallId = `edit-${randomUUID()}`;
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: 'Edit synthetic-turn.txt',
          kind: 'edit',
          status: 'pending',
        },
      });
      const response = await client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId, title: 'Edit synthetic-turn.txt', kind: 'edit', status: 'pending' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const outcome =
        response.outcome.outcome === 'selected' ? response.outcome.optionId : 'cancelled';
      record('permission-outcome', { sessionId, outcome });
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: outcome === 'allow-once' ? 'completed' : 'failed',
        },
      });
      await emitText(client, sessionId, `Synthetic permission outcome: ${outcome}.`);
      record('prompt-end', { sessionId, mode, stopReason: 'end_turn' });
      return { stopReason: 'end_turn' };
    }

    if (mode === 'hold') {
      // Long-running work that only ends when the process is stopped or killed.
      await emitText(client, sessionId, HOLD_OUTPUT);
      record('hold-started', { sessionId });
      await new Promise(() => {});
    }

    if (mode === 'crash') {
      // The provider dies while its prompt is still open, after streaming output.
      await emitText(client, sessionId, 'Synthetic output before the agent crash.');
      record('crash', { sessionId });
      await flushStdout();
      process.exit(17);
    }

    await emitText(client, sessionId, replies[mode] ?? 'Synthetic response complete.');
    record('prompt-end', { sessionId, mode, stopReason: 'end_turn' });
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
