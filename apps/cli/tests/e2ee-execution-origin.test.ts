import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { LoroDoc } from 'loro-crdt';
import { makeVerifiedExecutionOriginal } from '../src/lib/e2ee/verified-execution-original';
import { makeEncryptedAgentExecution } from '../src/lib/e2ee/agent-execution';

const selfDevice = 'aa'.repeat(32);
const requesterDevice = 'bb'.repeat(32);
const requesterCryptoUserId = 'cc'.repeat(32);
const original = { requesterDevice, requesterCryptoUserId, expiresAt: 900_000 };
const intent = { workspaceId: 'workspace', sessionId: 'session', userTurnId: 'turn' };

// Product assumption: a verified member origin's cached dispatch must not change
// whether its agent can derive another turn under that member's rights.
describe('shared member derivation with a locally cached signed dispatch', () => {
  const resolver = (
    cached: boolean,
    inputConfig: unknown = { prompt: 'synthetic member input' }
  ) => {
    const doc = new LoroDoc();
    const resolve = makeVerifiedExecutionOriginal({
      workspaceId: 'workspace',
      selfDevice,
      isClosed: () => false,
      readIncoming: () => Effect.succeed(cached ? { frame: Uint8Array.of(1) } : undefined),
      openDispatch: () =>
        Effect.succeed({
          args: { sessionId: 'session', userTurnId: 'turn', userId: 'display', inputConfig },
          requesterDevice,
          expiresAt: 900_000,
        }),
      ledger: () =>
        Effect.succeed({
          inspectState: () => ({
            devices: new Map([
              [
                selfDevice,
                { machineId: 'machine', membershipId: { toBytes: () => Uint8Array.of(1) } },
              ],
              [requesterDevice, { membershipId: { toBytes: () => Uint8Array.of(2) } }],
            ]),
            members: new Map([
              ['02', { userId: { toBytes: () => new Uint8Array(32).fill(0xcc) } }],
            ]),
          }),
        }),
      origins: { resolve: () => Effect.succeed(original) } as never,
      openContent: () => Effect.die('not used by the verified-origin seam'),
    });
    return {
      doc,
      resolve: (i: typeof intent & { inputConfig?: unknown }, lookup?: { origin?: boolean }) =>
        resolve(i, doc, lookup),
    };
  };

  it.each([false, true])('keeps member derivation available with cache=%s', async (cached) => {
    const { doc, resolve } = resolver(cached);
    try {
      const result = await Effect.runPromise(resolve(intent, { origin: true }));
      expect(result).toEqual(original);
      const gate = makeEncryptedAgentExecution({
        genesis: 'dd'.repeat(32),
        workspaceId: 'workspace',
        targetMachineId: 'machine',
        machineUserId: 'machine-owner',
        selfDevice,
        journal: () => {
          throw new Error('classification must not start execution');
        },
        resolveVerifiedOriginal: resolve,
        authorizeExecution: () => Effect.succeed({ _tag: 'Authorized', principal: 'member' }),
      });
      expect(await Effect.runPromise(gate.classifyOrigin(intent))).toBe('member');
    } finally {
      doc.free();
    }
  });

  it('keeps ordinary dispatch config checks strict', async () => {
    const { doc, resolve } = resolver(true);
    try {
      expect(
        await Effect.runPromise(
          resolve({ ...intent, inputConfig: { prompt: 'synthetic member input' } })
        )
      ).toEqual(original);
      expect(
        await Effect.runPromise(resolve({ ...intent, inputConfig: { prompt: 'tampered' } }))
      ).toBeUndefined();
    } finally {
      doc.free();
    }
  });

  it('does not reject the exceptional empty-config origin from the cache', async () => {
    const { doc, resolve } = resolver(true, {});
    try {
      expect(await Effect.runPromise(resolve(intent, { origin: true }))).toEqual(original);
    } finally {
      doc.free();
    }
  });
});
