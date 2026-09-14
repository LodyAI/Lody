import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const eventLogPath = process.argv[2];
const sessions = new Map();
const pendingInitialGoalPrompts = new Map();
const GOAL_START_MARKER = '[LODY-GOAL-001:START]';
const GOAL_UPDATE_MARKER = '[LODY-GOAL-001:UPDATE]';
const GOAL_OBJECTIVE = 'Publish the synthetic release checklist without user intervention.';
const UPDATED_GOAL_OBJECTIVE = 'Verify the synthetic release handoff and publish its evidence.';
const GOAL_CAPABILITY = {
  version: 1,
  actions: ['set', 'pause', 'resume', 'clear'],
  controlActions: ['pause', 'clear'],
  promptActions: ['set', 'pause', 'resume', 'clear'],
};

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

function goalSnapshot(status, revision = 'initial') {
  const updated = revision === 'updated';
  return {
    objective: updated ? UPDATED_GOAL_OBJECTIVE : GOAL_OBJECTIVE,
    status,
    tokenBudget: 10_000,
    tokensUsed: updated ? 4_200 : 1_200,
    timeUsedSeconds: updated ? 210 : 75,
    createdAtEpochSeconds: 1_700_000_000,
    updatedAtEpochSeconds: updated ? 1_700_000_210 : 1_700_000_075,
  };
}

async function publishGoal(client, sessionId, goal) {
  record('goal-snapshot', {
    sessionId,
    goalStatus: goal?.status ?? null,
    objective: goal?.objective ?? null,
    tokenBudget: goal?.tokenBudget ?? null,
    tokensUsed: goal?.tokensUsed ?? null,
    timeUsedSeconds: goal?.timeUsedSeconds ?? null,
  });
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'session_info_update',
      _meta: { lody: { goal } },
    },
  });
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

function parseGoalControlParams(params) {
  if (
    typeof params !== 'object' ||
    params === null ||
    typeof params.sessionId !== 'string' ||
    params.sessionId.length === 0 ||
    (params.action !== 'pause' && params.action !== 'clear')
  ) {
    throw new Error('Invalid synthetic goal control request');
  }
  return { sessionId: params.sessionId, action: params.action };
}

const agent = acp
  .agent({ name: 'lody-goal-e2e-agent' })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => {
    record('initialize', { goalCapability: GOAL_CAPABILITY });
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {
        _meta: {
          lody: {
            goal: GOAL_CAPABILITY,
          },
        },
      },
      agentInfo: { name: 'Lody Goal E2E Agent', version: '1' },
    };
  })
  .onRequest(acp.methods.agent.session.new, async () => {
    const sessionId = `goal-${randomUUID()}`;
    sessions.set(sessionId, { goal: null });
    record('session-new', { sessionId });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client, signal }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown goal session: ${params.sessionId}`);
    const text = promptText(params.prompt);
    const goalControl = params._meta?.lody?.goalControl;
    const mode = text.includes('You generate titles for coding sessions.')
      ? 'title'
      : goalControl?.version === 1 && goalControl.action === 'resume'
        ? 'resume-goal'
        : text.includes(GOAL_START_MARKER)
          ? 'initial-goal'
          : text.includes(GOAL_UPDATE_MARKER)
            ? 'update-goal'
            : 'other';
    record('prompt-start', {
      sessionId: params.sessionId,
      mode,
      promptText: text,
      ...(goalControl ? { goalControl } : {}),
    });

    if (mode === 'title') {
      await emitText(client, params.sessionId, 'Synthetic goal session');
      record('prompt-end', { sessionId: params.sessionId, mode, stopReason: 'end_turn' });
      return { stopReason: 'end_turn' };
    }

    if (mode === 'resume-goal') {
      session.goal = { ...session.goal, status: 'active' };
      await publishGoal(client, params.sessionId, session.goal);
      await emitText(client, params.sessionId, 'Synthetic goal resumed through prompt metadata.');
      record('prompt-end', { sessionId: params.sessionId, mode, stopReason: 'end_turn' });
      return { stopReason: 'end_turn' };
    }

    if (mode === 'initial-goal') {
      session.goal = goalSnapshot('active');
      await publishGoal(client, params.sessionId, session.goal);
      await emitText(client, params.sessionId, 'Synthetic goal is running.');
      return await new Promise((resolve) => {
        const finish = (stopReason) => {
          signal.removeEventListener('abort', onAbort);
          pendingInitialGoalPrompts.delete(params.sessionId);
          record('prompt-end', { sessionId: params.sessionId, mode, stopReason });
          resolve({ stopReason });
        };
        const onAbort = () => finish('cancelled');
        pendingInitialGoalPrompts.set(params.sessionId, { finish });
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }

    if (mode === 'update-goal') {
      session.goal = goalSnapshot('paused', 'updated');
      await publishGoal(client, params.sessionId, session.goal);
      await emitText(client, params.sessionId, 'Synthetic goal details updated through ACP.');
      record('prompt-end', { sessionId: params.sessionId, mode, stopReason: 'end_turn' });
      return { stopReason: 'end_turn' };
    }

    await emitText(client, params.sessionId, 'Synthetic response complete.');
    record('prompt-end', { sessionId: params.sessionId, mode, stopReason: 'end_turn' });
    return { stopReason: 'end_turn' };
  })
  .onRequest('_lody/session/goal', parseGoalControlParams, async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown goal session: ${params.sessionId}`);
    record('goal-control', { sessionId: params.sessionId, action: params.action });

    if (params.action === 'pause') {
      session.goal = { ...session.goal, status: 'paused' };
      await publishGoal(client, params.sessionId, session.goal);
      pendingInitialGoalPrompts.get(params.sessionId)?.finish('end_turn');
      return { goal: session.goal };
    }

    session.goal = null;
    await publishGoal(client, params.sessionId, null);
    return { goal: null };
  })
  .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
    pendingInitialGoalPrompts.get(params.sessionId)?.finish('cancelled');
  })
  .onRequest(acp.methods.agent.session.close, async ({ params }) => {
    pendingInitialGoalPrompts.get(params.sessionId)?.finish('cancelled');
    sessions.delete(params.sessionId);
    record('session-close', { sessionId: params.sessionId });
    return {};
  });

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
record('process-start');
agent.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
