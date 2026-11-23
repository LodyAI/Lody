import { Data, Effect } from 'effect';

/** Harness-private synthetic facts, never an attacker view or trust authority. */
export interface ContentWriteFact {
  readonly genesisHex: string;
  readonly stream: 'loro' | 'flock';
  readonly deviceHex: string;
  readonly epoch: number;
  readonly text: string;
  /** Independent decision at the writer's authenticated seal-time history. */
  readonly writerMayWrite: boolean | undefined;
}

export class LabTraceError extends Data.TaggedError('LabTraceError')<{
  readonly code: 'closed' | 'budget' | 'invalid-fact';
}> {}

/** Each run owns an independent bounded trace. No process-global plaintext log. */
export const makeLabContentTrace = Effect.fn('Lab.makeContentTrace')(function* (limits: {
  readonly maxFacts: number;
  readonly maxTextBytes: number;
}) {
  const maxFacts = limits.maxFacts,
    maxTextBytes = limits.maxTextBytes;
  if (
    !Number.isSafeInteger(maxFacts) ||
    maxFacts < 1 ||
    !Number.isSafeInteger(maxTextBytes) ||
    maxTextBytes < 1
  ) {
    return yield* new LabTraceError({ code: 'budget' });
  }
  let rows: readonly ContentWriteFact[] = [],
    bytes = 0,
    closed = false;
  yield* Effect.acquireRelease(Effect.void, () =>
    Effect.sync(() => {
      closed = true;
      rows = [];
      bytes = 0;
    })
  );
  return Object.freeze({
    recordContentWrite: (fact: ContentWriteFact) =>
      Effect.suspend(() => {
        if (closed) return Effect.fail(new LabTraceError({ code: 'closed' }));
        const owned: ContentWriteFact = {
          genesisHex: fact.genesisHex,
          stream: fact.stream,
          deviceHex: fact.deviceHex,
          epoch: fact.epoch,
          text: fact.text,
          writerMayWrite: fact.writerMayWrite,
        };
        if (
          !/^[0-9a-f]{64}$/.test(owned.genesisHex) ||
          !/^[0-9a-f]{64}$/.test(owned.deviceHex) ||
          (owned.stream !== 'loro' && owned.stream !== 'flock') ||
          !Number.isSafeInteger(owned.epoch) ||
          owned.epoch < 0 ||
          owned.epoch > 0xffffffff
        ) {
          return Effect.fail(new LabTraceError({ code: 'invalid-fact' }));
        }
        const size = Buffer.byteLength(owned.text, 'utf8');
        if (rows.length >= maxFacts || size > maxTextBytes - bytes) {
          return Effect.fail(new LabTraceError({ code: 'budget' }));
        }
        rows = [...rows, Object.freeze(owned)];
        bytes += size;
        return Effect.void;
      }),
    contentWritesFor: (genesisHex: string) =>
      Effect.suspend(() =>
        closed
          ? Effect.fail(new LabTraceError({ code: 'closed' }))
          : Effect.succeed(
              Object.freeze(
                rows
                  .filter((row) => row.genesisHex === genesisHex)
                  .map((row) => Object.freeze({ ...row }))
              )
            )
      ),
    clearContentWrites: () =>
      Effect.suspend(() => {
        if (closed) return Effect.fail(new LabTraceError({ code: 'closed' }));
        rows = [];
        bytes = 0;
        return Effect.void;
      }),
  });
});
