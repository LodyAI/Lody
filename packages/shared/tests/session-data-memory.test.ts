import { describe, expect, it } from 'vitest';
import { createMemorySessionData, type MemorySessionDataOptions } from '../src/session-data';
import type { SessionTurn } from '../src/session-data';
import {
  contractSessionId,
  runSessionDataContract,
  type SessionDataHarness,
} from './session-data-contract';

const makeHarness = (
  options: Omit<MemorySessionDataOptions, 'sessionId'> = {}
): SessionDataHarness => {
  const memory = createMemorySessionData({ sessionId: contractSessionId, ...options });
  const patch = (turnId: string, key: string, value: unknown) => {
    memory.applyPeerMutation((turns) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (turn) (turn as Record<string, unknown>)[key] = value;
    });
  };
  return {
    data: memory,
    injectStoredField: patch,
    peerSetField: patch,
    peerAppend: (turn) => {
      memory.applyPeerMutation((turns) => {
        turns.push(structuredClone(turn));
      });
    },
    readStored: () => memory.readStored(),
  };
};

runSessionDataContract('memory', () => makeHarness());

const userTurn = (turnId: string): SessionTurn => ({
  id: turnId,
  role: 'user',
  timestamp: '2026-01-01T00:00:00.000Z',
  items: [{ type: 'text', text: 'hello' }],
  fileDiff: [],
  status: 'pending',
});

describe('memory session data double', () => {
  it('re-locates the target at commit time after an interleaved peer edit', async () => {
    let peerEdited = false;
    const harness = makeHarness({
      initialTurns: [userTurn('a')],
      beforeCommit: () => {
        if (peerEdited) return;
        peerEdited = true;
        // A peer edits the target while our command is between its precondition
        // and its mutation. The write must land on the current row.
        harness.peerSetField('a', 'status', 'handled');
        harness.peerAppend(userTurn('peer'));
      },
    });
    const { data } = harness;

    const result = await data.commands.setTurnField('a', 'finished', {
      kind: 'set',
      value: true,
    });
    expect(result.status).toBe('accepted');
    const stored = harness.readStored();
    expect(stored.find((turn) => turn.id === 'a')?.finished).toBe(true);
    expect(stored.find((turn) => turn.id === 'a')?.status).toBe('handled');
    expect(stored.some((turn) => turn.id === 'peer')).toBe(true);
  });

  it('keeps acceptance when durability has not happened, and when it fails', async () => {
    const pending = makeHarness({ manualDurability: true });
    const accepted = await pending.data.commands.appendTurn(userTurn('a'));
    expect(accepted.status).toBe('accepted');
    if (accepted.status !== 'accepted') return;
    expect(pending.data.readStored()).toHaveLength(1);
    let durable = false;
    const waiting = pending.data.durability
      .waitDurable(accepted.receipt)
      .then(() => (durable = true));
    await Promise.resolve();
    expect(durable).toBe(false);
    pending.data.markDurable();
    await waiting;
    expect(durable).toBe(true);

    const failing = makeHarness({ failDurability: new Error('disk full') });
    const result = await failing.data.commands.appendTurn(userTurn('b'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    await expect(failing.data.durability.waitDurable(result.receipt)).rejects.toThrow('disk full');
    // A durability failure never becomes a pre-write rejection.
    expect(failing.readStored().some((turn) => turn.id === 'b')).toBe(true);
  });
});
