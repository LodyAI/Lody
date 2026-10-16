import { Effect, Exit, Result, Scope } from 'effect';
import { expect, it } from 'vitest';
import { makeLabContentTrace, type ContentWriteFact } from '../src/platform/content-trace';

const fact = (): ContentWriteFact => ({
  genesisHex: '11'.repeat(32),
  stream: 'loro',
  deviceHex: '22'.repeat(32),
  epoch: 0,
  text: 'original',
  writerMayWrite: undefined,
});

it('owns the original synthetic write facts, returned observations and independent run state', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* makeLabContentTrace({ maxFacts: 3, maxTextBytes: 64 });
        const second = yield* makeLabContentTrace({ maxFacts: 3, maxTextBytes: 64 });
        const input = { ...fact() };
        yield* first.recordContentWrite(input);
        input.text = 'caller replaced';
        input.writerMayWrite = true;
        const captured = yield* first.contentWritesFor(input.genesisHex);
        expect(captured).toEqual([fact()]);
        expect(Object.isFrozen(captured)).toBe(true);
        expect(() => {
          (captured[0] as { text: string }).text = 'observation replaced';
        }).toThrow();
        expect(yield* first.contentWritesFor(input.genesisHex)).toEqual([fact()]);
        yield* second.recordContentWrite({ ...fact(), text: 'independent', writerMayWrite: false });
        yield* first.clearContentWrites();
        expect(yield* first.contentWritesFor(input.genesisHex)).toEqual([]);
        expect(yield* second.contentWritesFor(input.genesisHex)).toEqual([
          { ...fact(), text: 'independent', writerMayWrite: false },
        ]);
        expect(yield* second.contentWritesFor('33'.repeat(32))).toEqual([]);
      })
    )
  );
});

it('refuses over-budget/invalid facts without changing owned observations, then explicitly clears its budget', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const trace = yield* makeLabContentTrace({ maxFacts: 1, maxTextBytes: 2 });
        const tooBig = yield* Effect.result(trace.recordContentWrite({ ...fact(), text: '🍊' }));
        expect(Result.isFailure(tooBig)).toBe(true);
        expect(yield* trace.contentWritesFor(fact().genesisHex)).toEqual([]);
        yield* trace.recordContentWrite({ ...fact(), text: 'ab' });
        const full = yield* Effect.result(trace.recordContentWrite({ ...fact(), text: '' }));
        expect(Result.isFailure(full)).toBe(true);
        expect(yield* trace.contentWritesFor(fact().genesisHex)).toEqual([
          { ...fact(), text: 'ab' },
        ]);
        yield* trace.clearContentWrites();
        let firstRead = true;
        yield* trace.recordContentWrite({
          ...fact(),
          get text() {
            const value = firstRead ? 'ab' : 'too long';
            firstRead = false;
            return value;
          },
        });
        expect(yield* trace.contentWritesFor(fact().genesisHex)).toEqual([
          { ...fact(), text: 'ab' },
        ]);
        yield* trace.clearContentWrites();
        const invalid = yield* Effect.result(
          trace.recordContentWrite({ ...fact(), text: '', epoch: -1 })
        );
        expect(Result.isFailure(invalid)).toBe(true);
        yield* trace.recordContentWrite({ ...fact(), text: 'cd' });
        expect(yield* trace.contentWritesFor(fact().genesisHex)).toEqual([
          { ...fact(), text: 'cd' },
        ]);
      })
    )
  );
});

it('closed run refuses admission and observations while another actual Scope retains its own facts', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.acquireRelease(Scope.make(), (value) =>
          Scope.close(value, Exit.void)
        );
        const first = yield* makeLabContentTrace({ maxFacts: 1, maxTextBytes: 64 }).pipe(
          Effect.provideService(Scope.Scope, scope)
        );
        const second = yield* makeLabContentTrace({ maxFacts: 1, maxTextBytes: 64 });
        yield* first.recordContentWrite(fact());
        yield* second.recordContentWrite(fact());
        yield* Scope.close(scope, Exit.void);
        for (const operation of [
          first.recordContentWrite(fact()),
          first.contentWritesFor(fact().genesisHex),
          first.clearContentWrites(),
        ]) {
          const result = yield* Effect.result(operation);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) expect(result.failure).toMatchObject({ code: 'closed' });
        }
        expect(yield* second.contentWritesFor(fact().genesisHex)).toEqual([fact()]);
      })
    )
  );
});
