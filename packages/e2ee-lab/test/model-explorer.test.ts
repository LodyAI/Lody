import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Result } from 'effect';
import { expect, it } from 'vitest';
import { makeLabAttackPlanModel, exploreLabAttacks } from '../src/platform/model-explorer';
import { captureModelActionPlan } from '../src/platform/action-executor';
it('uses recorded model responses and validates actions locally without model-supplied verdicts', async () => {
  let calls = 0;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const model = yield* makeLabAttackPlanModel({
          key: 'synthetic-not-a-credential',
          model: 'recorded-model',
          fetch: async (url, init) => {
            calls++;
            expect(url).toBe('https://api.openai.com/v1/responses');
            expect(JSON.parse(String(init?.body))).toMatchObject({
              store: false,
              text: { format: { type: 'json_object' } },
            });
            return new Response(
              JSON.stringify({
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    content: [
                      {
                        type: 'output_text',
                        text: JSON.stringify({
                          actions: [
                            {
                              kind: 'start',
                              actor: 'owner',
                              mode: 'create',
                              expect: { ok: false, refusal: { tag: 'fake', code: 'fake' } },
                            },
                          ],
                        }),
                      },
                    ],
                  },
                ],
              })
            );
          },
        });
        const text = yield* model.generate({ prompt: 'recorded synthetic attack', schema: {} });
        expect(captureModelActionPlan(JSON.parse(text).actions)).toEqual([
          { kind: 'start', actor: 'owner', mode: 'create' },
        ]);
      })
    )
  );
  expect(calls).toBe(1);
  expect(() =>
    captureModelActionPlan([{ kind: 'call', actor: 'owner', operation: 'pull' }])
  ).toThrow();
});
it('runs a recorded attack through actual native actors and only confirms its measured violation after deterministic replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-model-explorer-'));
  try {
    const actions = [
      { kind: 'start', actor: 'owner', mode: 'create' },
      { kind: 'call', actor: 'owner', operation: 'keys' },
      { kind: 'call', actor: 'owner', operation: 'revoke', target: 'peer' },
      { kind: 'call', actor: 'owner', operation: 'acknowledge' },
      { kind: 'call', actor: 'owner', operation: 'publish-without-stage' },
    ];
    const result = await Effect.runPromise(
      exploreLabAttacks({
        directory,
        goal: 'Measure an authenticated publisher withholding staged envelopes',
        model: { generate: () => Effect.succeed(JSON.stringify({ actions })) },
      })
    );
    expect(result.confirmed).toBe(1);
    expect(result.plans[0]).toMatchObject({
      confirmed: true,
      violations: expect.arrayContaining(['durability.committed-rotation-complete-group']),
    });
    const replay = JSON.parse(readFileSync(join(directory, 'plan-0/replay-result.json'), 'utf8'));
    expect(replay.reproduced).toBe(true);
    expect(replay.matched).toBe(true);
    // An invalid proposal is a tool input failure, never a security finding.
    const bad = yieldFreeResult(
      exploreLabAttacks({
        directory: join(directory, 'bad'),
        goal: 'invalidplan',
        model: { generate: () => Effect.succeed('{"actions":[{"kind":"shell","actor":"owner"}]}') },
      })
    );
    expect(Result.isFailure(await bad)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
const yieldFreeResult = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.result(effect));

it('does not turn a hostile host 403 into a confirmed policy violation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-model-host-denial-'));
  try {
    const actions = [
      { kind: 'start', actor: 'owner', mode: 'create' },
      {
        kind: 'transport',
        actor: 'owner',
        action: {
          kind: 'intercept',
          target: { actor: 'owner', stream: 'control', method: 'GET', occurrence: 1 },
          mutation: { kind: 'replace', status: 403, bodyHex: '' },
        },
      },
      { kind: 'call', actor: 'owner', operation: 'refresh' },
    ];
    const result = await Effect.runPromise(
      exploreLabAttacks({
        directory,
        goal: 'Host refuses an otherwise authorized control read',
        model: { generate: () => Effect.succeed(JSON.stringify({ actions })) },
      })
    );
    expect(result.confirmed).toBe(0);
    expect(result.plans[0]!.violations).toEqual([]);
    const artifact = JSON.parse(readFileSync(join(directory, 'plan-0/evidence.json'), 'utf8'));
    expect(artifact.run.observations.at(-1).reply.error).toEqual({
      tag: 'LedgerFeedError',
      code: 'forbidden',
    });
    expect(artifact.measurements.modelMeasurements.at(-1).verdict).toBe('unavailable');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
