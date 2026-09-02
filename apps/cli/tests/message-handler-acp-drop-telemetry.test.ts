/**
 * Drop telemetry has to be interpretable.
 *
 * `out_of_turn_acp_update_without_target` fires both when there is no turn at
 * all and when a LIVE turn has not claimed ACP routing yet, and only the second
 * is a bug. Without `reason`/`turn_phase`/`turn_epoch` the two are the same
 * event, so the rollout signal this whole change is measured by cannot be read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcpSessionNotification, SessionId } from '@lody/shared';

import type { SessionDocument } from '../src/lib/loro/doc';
import { loadEnv } from '../src/utils/const';
import { captureCli } from '../src/lib/analytics/posthog';
import { createMessageHandlerHarness, destroyRepoOnRealTimers } from './message-handler-harness';

vi.mock('../src/lib/analytics/posthog', () => ({ captureCli: vi.fn() }));

const originalLodyServerUrl = process.env.LODY_SERVER_URL;

type MessageHandlerHost = {
  beginConversationTurn(
    sessionId: SessionId,
    userTurnId?: string,
    gateContext?: { sessionDoc: SessionDocument; deferACPUpdateTarget?: boolean }
  ): string;
  enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
};

const agentChunk = (sessionId: SessionId): AcpSessionNotification => ({
  sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
});

const dropProps = () =>
  vi
    .mocked(captureCli)
    .mock.calls.filter((c) => c[0] === 'out_of_turn_acp_update_without_target')
    .map((c) => c[1] as Record<string, unknown>);

describe('MessageHandler ACP drop telemetry', () => {
  beforeEach(() => {
    vi.mocked(captureCli).mockClear();
    process.env.LODY_SERVER_URL = 'https://server.example.test';
    loadEnv();
  });

  afterEach(() => {
    if (originalLodyServerUrl === undefined) {
      delete process.env.LODY_SERVER_URL;
    } else {
      process.env.LODY_SERVER_URL = originalLodyServerUrl;
    }
    loadEnv();
  });

  it('distinguishes a live turn that has not claimed routing from no turn at all', async () => {
    const sessionId = 's-drop-telemetry' as SessionId;
    const { repo, doc, handler } = await createMessageHandlerHarness(sessionId);
    const host = handler as unknown as MessageHandlerHost;

    try {
      // No turn at all.
      host.enqueueACPUpdate(sessionId, agentChunk(sessionId));

      // A live turn that has not claimed ACP routing yet — the shape that lost
      // 505 seconds of output, and the only one of the two that is a bug.
      host.beginConversationTurn(sessionId, 'user-1', {
        sessionDoc: doc,
        deferACPUpdateTarget: true,
      });
      host.enqueueACPUpdate(sessionId, agentChunk(sessionId));

      const [noTurn, deferredTurn] = dropProps();
      expect(noTurn).toMatchObject({
        reason: 'turn_idle_without_late_target',
        turn_phase: 'idle',
      });
      expect(noTurn?.turn_epoch).toBeUndefined();
      expect(deferredTurn).toMatchObject({
        reason: 'turn_not_owning_acp_updates',
        turn_phase: 'prompting',
        turn_epoch: 1,
      });
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });
});
