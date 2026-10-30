import { afterEach, describe, expect, it } from 'vitest';
import { Effect, Exit, Result } from 'effect';
import { Bytes, ContentError, sealRpcRequestContent } from '@lody/e2ee-core/protocol';
import { e2eeRpcResource } from '@lody/loro-streams-rpc/e2ee-resource';
import { copyEpochKeyBytes } from '../../../../../packages/e2ee-core/src/internal/foundation/epoch-key';
import { encryptedRpcFixture } from '../../../../../packages/loro-streams-rpc/tests/fixtures/e2ee-native-fixture';
import {
  makeLedgerCatchUp,
  withLedgerCatchUp,
  type LedgerCatchUpEvent,
} from './rpc-ledger-catch-up';

const fixtures: ReturnType<typeof encryptedRpcFixture>[] = [];
afterEach(() => {
  for (const value of fixtures.splice(0)) value.close();
});
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

// The machine verified epoch 0. `advance` models the refresh reaching epoch 1;
// the fake open mirrors the core guard: only a caught-up machine opens epoch 1.
function machine(options: { advance?: boolean } = {}) {
  const f = encryptedRpcFixture();
  fixtures.push(f);
  let caughtUp = false;
  let catchUps = 0;
  let clock = 0;
  const release = Promise.withResolvers<void>();
  let gate: Promise<void> | undefined;
  const events: LedgerCatchUpEvent[] = [];
  const wrap = makeLedgerCatchUp({
    genesis: hex(f.ledger.context.genesis.toBytes()),
    resource: e2eeRpcResource,
    ledger: f.ledger.ledger,
    catchUp: async () => {
      catchUps++;
      await gate;
      if (options.advance) caughtUp = true;
    },
    now: () => clock,
    cooldownMs: 60_000,
    observe: (event) => events.push(event),
  });
  const open = wrap((_machineId: string, frameHex: string) =>
    Effect.suspend(() =>
      caughtUp ? Effect.succeed(frameHex) : Effect.fail(new ContentError({ code: 'unauthorized' }))
    )
  );
  const seal = (epoch: number, signer = f.ledger.owner.signer) =>
    Effect.runPromise(
      sealRpcRequestContent({
        scope: {
          genesis: hex(f.ledger.context.genesis.toBytes()),
          resource: e2eeRpcResource(f.machineId),
          epoch,
        },
        epochKey: Result.getOrThrow(Bytes.epochKey(copyEpochKeyBytes(f.ledger.secret))),
        signer,
        plaintext: new Uint8Array([1, 2, 3]),
      })
    ).then(hex);
  return {
    f,
    open: (frameHex: string) => Effect.runPromiseExit(open(f.machineId, frameHex)),
    seal,
    events,
    catchUps: () => catchUps,
    hold: () => {
      gate = release.promise;
    },
    release: () => release.resolve(),
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe('dispatch open after an epoch rotation', () => {
  it('catches up once and reopens a frame a ledger device sealed at the newer epoch', async () => {
    const m = machine({ advance: true });
    const frame = await m.seal(1);
    expect(Exit.isSuccess(await m.open(frame))).toBe(true);
    expect(m.catchUps()).toBe(1);
    expect(m.events).toEqual([{ frameEpoch: 1, localEpoch: 0, outcome: 'caught-up' }]);
  });

  it('never refreshes for a frame at or below the verified epoch', async () => {
    const m = machine();
    expect(Exit.isFailure(await m.open(await m.seal(0)))).toBe(true);
    expect(m.catchUps()).toBe(0);
    expect(m.events.map((event) => event.outcome)).toEqual(['not-newer']);
  });

  it('never refreshes for unauthenticated high-epoch frames, however often replayed', async () => {
    const m = machine();
    const valid = Buffer.from(await m.seal(0xffffffff), 'hex');
    const zeroSignature = hex(Buffer.concat([valid.subarray(0, -64), Buffer.alloc(64)]));
    const outsider = await m.seal(0xffffffff, m.f.ledger.ed(50).signer);
    for (let replay = 0; replay < 16; replay++) {
      expect(Exit.isFailure(await m.open(zeroSignature))).toBe(true);
      expect(Exit.isFailure(await m.open(outsider))).toBe(true);
    }
    expect(m.catchUps()).toBe(0);
    expect(new Set(m.events.map((event) => event.outcome))).toEqual(new Set(['unauthenticated']));
  });

  it('cools down after a catch-up that does not advance the verified ledger', async () => {
    const m = machine();
    const frame = await m.seal(7);
    for (let replay = 0; replay < 16; replay++)
      expect(Exit.isFailure(await m.open(frame))).toBe(true);
    expect(m.catchUps()).toBe(1);
    expect(m.events.filter((event) => event.outcome === 'cooldown')).toHaveLength(15);
    m.tick(60_000);
    expect(Exit.isFailure(await m.open(frame))).toBe(true);
    expect(m.catchUps()).toBe(2);
  });

  it('shares one wait among concurrent frames instead of one per receive worker', async () => {
    const m = machine({ advance: true });
    m.hold();
    const frames = await Promise.all([1, 1, 1, 1].map((epoch) => m.seal(epoch)));
    const opened = frames.map((frame) => m.open(frame));
    await Promise.resolve();
    m.release();
    expect((await Promise.all(opened)).every(Exit.isSuccess)).toBe(true);
    expect(m.catchUps()).toBe(1);
  });
});

describe('feature requests share the dispatch catch-up', () => {
  it('reopens a feature request sealed after rotation through the same budget', async () => {
    const m = machine({ advance: true });
    const f = m.f;
    let featureOpens = 0;
    let caughtUp = false;
    const wrap = makeLedgerCatchUp({
      genesis: hex(f.ledger.context.genesis.toBytes()),
      resource: e2eeRpcResource,
      ledger: f.ledger.ledger,
      catchUp: async () => {
        caughtUp = true;
      },
    });
    const reject = () => Effect.fail(new ContentError({ code: 'unauthorized' }));
    const native = withLedgerCatchUp(
      {
        openDispatch: (_machineId: string, _frameHex: string) => reject(),
        openFeature: (_machineId: string, _frameHex: string) =>
          Effect.suspend(() => {
            featureOpens++;
            return caughtUp ? Effect.succeed('feature') : reject();
          }),
        close: () => 'kept',
      },
      wrap
    );
    const frame = await m.seal(1);
    expect(await Effect.runPromise(native.openFeature(f.machineId, frame))).toBe('feature');
    expect(featureOpens).toBe(2);
    expect(native.close()).toBe('kept');
  });
});
