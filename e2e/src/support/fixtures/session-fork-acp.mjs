import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const eventLogPath = process.argv[2];
const sessions = new Set();

function record(event, details = {}) {
  appendFileSync(
    eventLogPath,
    `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details })}\n`,
    'utf8'
  );
}

const agent = acp
  .agent({ name: 'lody-session-fork-e2e-agent' })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: {
      sessionCapabilities: { fork: {} },
      _meta: { lody: { forkAtTurn: { version: 1 } } },
    },
    agentInfo: { name: 'Lody Session Fork E2E Agent', version: '1' },
  }))
  .onRequest(acp.methods.agent.session.new, async ({ params }) => {
    const sessionId = `session-fork-${randomUUID()}`;
    sessions.add(sessionId);
    record('session-new', { sessionId, cwd: params.cwd });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    if (!sessions.has(params.sessionId)) throw new Error(`Unknown session: ${params.sessionId}`);
    const turnId = `fork-turn-${randomUUID()}`;
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Synthetic forkable response complete.' },
        _meta: { lody: { turnId } },
      },
    });
    record('prompt-end', { sessionId: params.sessionId, turnId });
    return { stopReason: 'end_turn' };
  })
  .onRequest(acp.methods.agent.session.fork, async ({ params }) => {
    const sessionId = `session-fork-${randomUUID()}`;
    sessions.add(sessionId);
    const sourceTurnId = params._meta?.lody?.forkAtTurn?.turnId;
    record('session-fork', {
      sourceSessionId: params.sessionId,
      sourceTurnId,
      sessionId,
      cwd: params.cwd,
    });
    return { sessionId };
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
