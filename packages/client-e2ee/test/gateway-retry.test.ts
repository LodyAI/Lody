import { expect, it } from 'vitest';
import { Effect, Exit, ManagedRuntime, Result } from 'effect';
import { TestClock } from 'effect/testing';
import { Bytes } from '@lody/e2ee-core/protocol';
import {
  BackendRefusal,
  E2eeAccessRefusal,
  MemberInvitationRefusedError,
  makePersonalCloudNetwork,
  type PersonalCloudConnection,
} from '../src/network';
import { makePersonalCloudAccountPairingRelay } from '../src/account-pairing';

function fixture(
  kind: 'network' | 'pairing',
  work: () => Promise<unknown>,
  options: {
    retryBackoffMs?: readonly number[];
    requestTimeoutMs?: number;
  } = { retryBackoffMs: [0, 0] }
) {
  let account = 'account-A';
  const input = {
    client: {
      query: work,
      action: work,
      mutation: work,
    } as unknown as PersonalCloudConnection['client'],
    currentAccount: () => Effect.sync(() => account),
    ...options,
  };
  const call: () => Effect.Effect<unknown, unknown> =
    kind === 'network'
      ? () =>
          makePersonalCloudNetwork({
            ...input,
            scope: {
              accountId: 'account-A',
              workspaceId: 'workspace-A',
              genesis: Result.getOrThrow(Bytes.genesisHash(new Uint8Array(32).fill(17))),
            },
          })
            .mailbox('cc'.repeat(32))
            .read('dd'.repeat(16))
      : () => makePersonalCloudAccountPairingRelay(input).claim('aa'.repeat(16));
  return {
    call,
    switchAccount: () => {
      account = 'account-B';
    },
  };
}

for (const kind of ['network', 'pairing'] as const) {
  it.each([502, 503, 504])(
    `${kind} recovers from transient %s within two retries`,
    async (status) => {
      let calls = 0;
      const { call } = fixture(kind, async () => {
        if (++calls < 3) throw Object.assign(new Error('gateway'), { status });
        return null;
      });
      expect(await Effect.runPromise(call())).toBeNull();
      expect(calls).toBe(3);
    }
  );

  it(`${kind} stops after three failed gateway attempts even with a longer configured backoff`, async () => {
    let calls = 0;
    const { call } = fixture(
      kind,
      async () => {
        calls++;
        throw new Error('Server Error: 503 Service Unavailable');
      },
      { retryBackoffMs: [0, 0, 0, 0] }
    );
    expect(Exit.isFailure(await Effect.runPromiseExit(call()))).toBe(true);
    expect(calls).toBe(3);
  });

  it.each([
    ...[401, 403, 409, 429, 560].map((status) => Object.assign(new Error('refused'), { status })),
    ...['e2ee_device_revoked', 'e2ee_member_removed', 'e2ee_unknown'].map((code) =>
      Object.assign(new Error('refused'), { status: 503, data: { code } })
    ),
    new E2eeAccessRefusal('e2ee_device_revoked'),
    new BackendRefusal('e2ee_unknown'),
    new MemberInvitationRefusedError('e2ee_member_invitation_request_pending'),
    new TypeError('Failed to fetch'),
    Object.assign(new Error('e2ee_refused'), { status: 503 }),
  ])(`${kind} immediately surfaces non-gateway or E2EE refusal %s without retry`, async (error) => {
    let calls = 0;
    const { call } = fixture(kind, async () => {
      calls++;
      throw error;
    });
    expect(Exit.isFailure(await Effect.runPromiseExit(call()))).toBe(true);
    expect(calls).toBe(1);
  });

  it(`${kind} does not retry a malformed successful response`, async () => {
    let calls = 0;
    const { call } = fixture(kind, async () => {
      calls++;
      return { invalid: true };
    });
    expect(Exit.isFailure(await Effect.runPromiseExit(call()))).toBe(true);
    expect(calls).toBe(1);
  });

  it(`${kind} advances both default retry delays on TestClock without real sleeps`, async () => {
    const runtime = ManagedRuntime.make(TestClock.layer({ warningDelay: '1 hour' }));
    try {
      await runtime.context();
      let calls = 0;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const { call } = fixture(
        kind,
        async () => {
          calls++;
          entered();
          if (calls < 3) throw Object.assign(new Error('gateway'), { status: 504 });
          return null;
        },
        {}
      );
      const pending = runtime.runPromiseExit(call());
      await started;
      await runtime.runPromise(TestClock.adjust(210));
      expect(Exit.isSuccess(await pending)).toBe(true);
      expect(calls).toBe(3);
    } finally {
      await runtime.dispose();
    }
  });

  it(`${kind} includes Effect-clock backoff in the total timeout and never retries after it`, async () => {
    const runtime = ManagedRuntime.make(TestClock.layer({ warningDelay: '1 hour' }));
    try {
      await runtime.context();
      let calls = 0;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const { call } = fixture(
        kind,
        async () => {
          calls++;
          entered();
          throw Object.assign(new Error('gateway'), { status: 502 });
        },
        { requestTimeoutMs: 50 }
      );
      const pending = runtime.runPromiseExit(call());
      await started;
      await runtime.runPromise(TestClock.adjust(50));
      expect(Exit.isFailure(await pending)).toBe(true);
      await runtime.runPromise(TestClock.adjust(1000));
      expect(calls).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it(`${kind} stops before resending after the account changes`, async () => {
    let calls = 0;
    const f = fixture(kind, async () => {
      calls++;
      f.switchAccount();
      throw Object.assign(new Error('gateway'), { status: 503 });
    });
    expect(Exit.isFailure(await Effect.runPromiseExit(f.call()))).toBe(true);
    expect(calls).toBe(1);
  });
}
