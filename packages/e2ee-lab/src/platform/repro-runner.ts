import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Effect } from 'effect';
import { captureLabActionPack, LabReproError } from './repro-pack';
import { runLabScenario } from './scenario-runner';
import { summarizeLabActions, type LabAction, type LabActionObservation } from './action-executor';
import { fingerprintOf, preserveSecurityFailure, isSecurityFingerprint } from '../pure/fingerprint';
import { worstVerdict, type JudgeVerdict } from '../pure/judge';
import { minimizeCounterexample } from '../pure/minimize';

const projection = (observation: LabActionObservation) => {
  const value = observation.reply.value as
    | { outcome?: unknown; text?: unknown; status?: unknown; length?: unknown; persisted?: unknown }
    | undefined;
  return {
    ok: observation.reply.ok,
    refusal: observation.reply.error ?? null,
    outcome: value?.outcome ?? null,
    text: value?.text ?? null,
    status: value?.status ?? null,
    length: value?.length ?? null,
    persisted: value?.persisted === undefined ? 'unobserved' : value.persisted !== null,
    cipherChanged: observation.reply.trace?.cipherChanged ?? null,
    ackDropped: observation.reply.trace?.ackDropped ?? null,
    integrity: observation.integrity,
    durability: observation.durability,
    checks: observation.checks,
  };
};
/** Reexecute the owned action/permit plan on fresh actual OS actors, SQLite,
 * HTTP and public crypto. Compare measured outcomes, not newly random signatures,
 * document snapshot digests, process IDs or regenerated ciphertext bytes. */
export const replayLabActions = Effect.fn('Lab.replayActions')(function* (input: {
  readonly pack: unknown;
  readonly directory: string;
  readonly sourceDirectory: string;
}) {
  const directory = input.directory;
  const pack = yield* Effect.try({
    try: () => captureLabActionPack(input.pack),
    catch: (cause) => cause,
  });
  const replay = yield* runLabScenario({
    directory,
    replaySource: {
      directory: join(input.sourceDirectory, 'private-replay'),
      sha256: pack.privateReplay.sha256,
    },
    actions: pack.observations.map((row) => row.action),
    schedule: pack.schedule,
    maxSteps: 256,
  });
  const differences: { index: number; expected: unknown; actual: unknown }[] = [];
  for (
    let index = 0;
    index < Math.max(pack.observations.length, replay.run.observations.length);
    index++
  ) {
    const left = pack.observations[index],
      right = replay.run.observations[index];
    const expected = left ? projection(left) : null,
      actual = right ? projection(right) : null;
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      differences.push({ index, expected, actual });
  }
  if (JSON.stringify(pack.properties) !== JSON.stringify(replay.run.properties))
    differences.push({ index: -1, expected: pack.properties, actual: replay.run.properties });
  return {
    scope: 'captured-original-action-material' as const,
    verdict: replay.run.verdict,
    matched: differences.length === 0,
    reproduced:
      differences.length === 0 &&
      (replay.run.verdict === 'pass' || replay.run.verdict === 'violation'),
    differences,
    run: replay.run,
    coverage: {
      originalCiphertextReplay:
        'exact-original-inputs-with-actual-crypto-import-and-persistence' as const,
      resealEquality: 'unsupported' as const,
      confidentiality: 'measured-properties-only' as const,
      frameCountComparison: 'not-compared' as const,
      nativeIdentityAndDurableBytes: 'original-synthetic-device-and-fresh-native-owners' as const,
    },
  };
});

/** Each trial uses fresh real owners and independent durable files. Structural
 * dependencies/old observation references are remapped; invalid or failed trials
 * are not successful preservation. There is no pretend defective client. */
export const minimizeLabActions = Effect.fn('Lab.minimizeActions')(function* (input: {
  readonly pack: unknown;
  readonly directory: string;
  readonly sourceDirectory: string;
  readonly maxTrials?: number;
}) {
  const directory = input.directory,
    maxTrials = input.maxTrials ?? 16;
  if (!Number.isSafeInteger(maxTrials) || maxTrials < 0 || maxTrials > 64)
    return yield* new LabReproError({ code: 'budget' });
  const pack = yield* Effect.try({
    try: () => captureLabActionPack(input.pack),
    catch: (cause) => cause,
  });
  const items = pack.observations.map((row, originalIndex) => ({
    action: row.action,
    originalIndex,
  }));
  const fingerprint = (
    observations: readonly LabActionObservation[],
    indices: readonly number[],
    properties: readonly { id: string; verdict: JudgeVerdict }[] = []
  ) => {
    const report = summarizeLabActions(observations);
    const value = fingerprintOf({
      integrity: worstVerdict([
        report.integrity,
        ...properties
          .filter((row) => row.id.startsWith('integrity.') && row.verdict !== 'unavailable')
          .map((row) => row.verdict),
      ]),
      durability: worstVerdict([
        report.durability,
        ...properties
          .filter((row) => row.id.startsWith('durability.') && row.verdict !== 'unavailable')
          .map((row) => row.verdict),
      ]),
      confidentiality: worstVerdict(
        properties
          .filter((row) => row.id.startsWith('confidentiality.') && row.verdict !== 'unavailable')
          .map((row) => row.verdict)
      ),
    });
    // Stable original action identities retain the actual failing measurement.
    // A different removed action causing the same coarse verdict is insufficient.
    return {
      ...value,
      rules: [
        ...properties.filter((row) => row.verdict === 'violation').map((row) => row.id),
        ...observations.flatMap((row, index) =>
          ['integrity', 'durability'].flatMap((dimension) =>
            row[dimension as 'integrity' | 'durability'] === 'violation'
              ? [
                  `${dimension}.action.${indices[index]}.${createHash('sha256')
                    .update(JSON.stringify(projection(row)))
                    .digest('hex')}`,
                ]
              : []
          )
        ),
      ],
    };
  };
  yield* Effect.try({
    try: () => mkdirSync(directory, { mode: 0o700 }),
    catch: (cause) => cause,
  });
  const original = fingerprint(
    pack.observations,
    items.map((row) => row.originalIndex),
    pack.properties
  );
  if (!isSecurityFingerprint(original)) return yield* new LabReproError({ code: 'not-reproduced' });
  const baselinePath = join(directory, 'baseline');
  yield* Effect.try({
    try: () => mkdirSync(baselinePath, { mode: 0o700 }),
    catch: (cause) => cause,
  });
  const baseline = yield* runLabScenario({
    directory: baselinePath,
    replaySource: {
      directory: join(input.sourceDirectory, 'private-replay'),
      sha256: pack.privateReplay.sha256,
    },
    actions: items.map((row) => row.action),
    schedule: pack.schedule,
    maxSteps: 256,
  });
  if (
    !preserveSecurityFailure(
      original,
      fingerprint(
        baseline.run.observations,
        items.map((row) => row.originalIndex),
        baseline.run.properties
      )
    ).preserved
  )
    return yield* new LabReproError({ code: 'not-reproduced' });
  let trial = 0;
  const result = yield* minimizeCounterexample({
    items,
    fingerprint: original,
    maxTrials,
    run: (candidate) =>
      Effect.gen(function* () {
        const indices = candidate.map((row) => row.originalIndex);
        const actions: LabAction[] = [];
        for (const row of candidate) {
          const target = row.action.expect?.unchangedFrom;
          const mapped = target === undefined ? undefined : indices.indexOf(target);
          if (mapped === -1) return { fingerprint: null };
          actions.push(
            mapped === undefined
              ? row.action
              : { ...row.action, expect: { ...row.action.expect!, unchangedFrom: mapped } }
          );
        }
        const path = join(directory, `trial-${++trial}`);
        yield* Effect.try({ try: () => mkdirSync(path, { mode: 0o700 }), catch: (cause) => cause });
        const measured = yield* Effect.result(
          runLabScenario({
            directory: path,
            actions,
            maxSteps: 256,
            sourceIndices: indices,
            replaySource: {
              directory: join(input.sourceDirectory, 'private-replay'),
              sha256: pack.privateReplay.sha256,
            },
          })
        );
        // This deliberately does not catch defects or interruption. A typed failed
        // trial is merely not preserved; its directory retains actual evidence.
        if (measured._tag === 'Failure') return { fingerprint: null };
        if (measured.success.run.verdict === 'harness-error') return { fingerprint: null };
        return {
          fingerprint: fingerprint(
            measured.success.run.observations,
            indices,
            measured.success.run.properties
          ),
        };
      }),
  });
  if (result.items.length === 0) return yield* new LabReproError({ code: 'missing-observation' });
  const finalIndices = result.items.map((row) => row.originalIndex);
  return {
    ...result,
    actions: result.items.map((row) =>
      row.action.expect?.unchangedFrom === undefined
        ? row.action
        : {
            ...row.action,
            expect: {
              ...row.action.expect,
              unchangedFrom: finalIndices.indexOf(row.action.expect.unchangedFrom),
            },
          }
    ),
    baseline: 'reproduced-with-original-material-and-fresh-owners' as const,
    scope: 'finite-action-outcomes' as const,
    coverage: 'partial' as const,
    limits: [
      'Captured signed and ciphertext originals reused per trial',
      'Only prepared immutable inputs are restored; results, native documents and cursors execute anew',
      'No entropy or regenerated-ciphertext equality',
      'Not a globally minimal proof',
    ],
  };
});
