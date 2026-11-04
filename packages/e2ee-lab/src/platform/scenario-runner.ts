import { type LedgerView } from '@lody/e2ee-core';
import { decodeRecord, hashRecordBytes, verifyLedger } from '@lody/e2ee-core/protocol';
import { getCommittedEpochStagingKey } from '@lody/e2ee-core/protocol';
import { labImplementationIdentity } from './evidence';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Result, Data, Effect } from 'effect';
import { makeLabScenarioFixture } from './scenario-fixture';
import { exportDevice } from './device';
import { makeLabProcessActor } from './process-actor';
import { executeLabActions, summarizeLabActions, type LabAction } from './action-executor';
import { fingerprintOf } from '../pure/fingerprint';
import { makeLabSdkOwner } from './sdk-owner';
import { readBoundedBody } from './bounded-body';
import type { ScheduleChoice } from '../pure/schedule';
import { loadPrivateReplay, savePrivateReplay } from './private-replay';
import { captureLabActors, type LabActorConfiguration } from '../pure/actor-config';
import { refStateFromOrg, refWriteExpectation } from '../pure/reference-model';
import {
  refActionPrediction,
  judgeRefAction,
  judgeConcurrentRefAction,
  type RefActionPrediction,
} from '../pure/action-model';
import { makeLabContentTrace } from './content-trace';
import { makeLabAttackTransport } from './attack-transport';
import { applyLabStorageMutation } from './storage-attack';
import { makeLabActorProxy } from './attack-proxy';
import { measureLabCursors } from './cursor-observer';
import { observeLabBackendBytes } from './backend-observer';
import { measureLabScenarioProbes } from './scenario-probes';
import { makeLabAttackObserver } from './attack-observer';
import { judgeWriteObservation, worstVerdict } from '../pure/judge';
export class LabScenarioError extends Data.TaggedError('LabScenarioError')<{
  readonly code: 'watchdog';
}> {}
const good = { ok: true } as const;
/** Finite default scenario for an explicitly prepared existing workspace.
 * Other plans opt into staged epochs and snapshots; no deterministic first seal. */
export const existingWorkspaceActions: readonly LabAction[] = [
  { kind: 'start', actor: 'owner', mode: 'create', expect: good },
  { kind: 'start', actor: 'peer', mode: 'create', expect: good },
  { kind: 'call', actor: 'owner', operation: 'keys', expect: good },
  { kind: 'call', actor: 'peer', operation: 'keys', expect: good },
  { kind: 'call', actor: 'owner', operation: 'create', document: 'loro', expect: good },
  { kind: 'call', actor: 'owner', operation: 'create', document: 'flock', expect: good },
  {
    kind: 'call',
    actor: 'owner',
    operation: 'append',
    document: 'loro',
    text: 'synthetic hello',
    expect: good,
  },
  {
    kind: 'call',
    actor: 'owner',
    operation: 'append',
    document: 'flock',
    text: 'synthetic flock',
    expect: good,
  },
  { kind: 'persist', actor: 'owner', document: 'loro', expect: good },
  { kind: 'call', actor: 'peer', operation: 'pull', document: 'loro', expect: good },
  { kind: 'call', actor: 'peer', operation: 'pull', document: 'flock', expect: good },
  {
    kind: 'call',
    actor: 'peer',
    operation: 'observe',
    document: 'loro',
    expect: { ok: true, text: 'synthetic hello' },
  },
  { kind: 'crash', actor: 'owner', expect: good },
  { kind: 'start', actor: 'owner', mode: 'open', expect: good },
  {
    kind: 'call',
    actor: 'owner',
    operation: 'observe',
    document: 'loro',
    expect: { ok: true, text: 'synthetic hello' },
  },
  {
    kind: 'call',
    actor: 'owner',
    operation: 'observe',
    document: 'flock',
    expect: { ok: true, text: 'synthetic flock' },
  },
  {
    kind: 'call',
    actor: 'owner',
    operation: 'append',
    document: 'loro',
    text: ' resumed',
    expect: good,
  },
  { kind: 'attack', actor: 'peer', attack: 'corrupt-loro', expect: good },
  {
    kind: 'call',
    actor: 'peer',
    operation: 'pull',
    document: 'loro',
    expect: { ok: false, refusal: { tag: 'LabContentError', code: 'decrypt_failed' } },
  },
  {
    kind: 'call',
    actor: 'peer',
    operation: 'observe',
    document: 'loro',
    expect: { ok: true, unchangedFrom: 11 },
  },
  { kind: 'call', actor: 'peer', operation: 'pull', document: 'flock', expect: good },
  {
    kind: 'call',
    actor: 'peer',
    operation: 'observe',
    document: 'flock',
    expect: { ok: true, text: 'synthetic flock' },
  },
  { kind: 'attack', actor: 'peer', attack: 'clear', expect: good },
  { kind: 'call', actor: 'peer', operation: 'recover', document: 'loro', expect: good },
  {
    kind: 'call',
    actor: 'peer',
    operation: 'observe',
    document: 'loro',
    expect: { ok: true, text: 'synthetic hello resumed' },
  },
  { kind: 'attack', actor: 'peer', attack: 'deny-loro-persist', expect: good },
  {
    kind: 'persist',
    actor: 'peer',
    document: 'loro',
    expect: { ok: false, refusal: { tag: 'LabDocumentError', code: 'sqlite' } },
  },
  {
    kind: 'call',
    actor: 'peer',
    operation: 'observe',
    document: 'loro',
    expect: { ok: true, unchangedFrom: 24 },
  },
  { kind: 'attack', actor: 'peer', attack: 'restore-loro-persist', expect: good },
  { kind: 'call', actor: 'peer', operation: 'recover', document: 'loro', expect: good },
  {
    kind: 'call',
    actor: 'peer',
    operation: 'observe',
    document: 'loro',
    expect: { ok: true, text: 'synthetic hello resumed' },
  },
  { kind: 'attack', actor: 'owner', attack: 'drop-control-ack', expect: good },
  {
    kind: 'call',
    actor: 'owner',
    operation: 'revoke',
    target: 'peer',
    expect: { ok: false, refusal: { tag: 'LabTransportFault', code: 'dropped-committed-ack' } },
  },
  { kind: 'crash', actor: 'owner', expect: good },
  { kind: 'start', actor: 'owner', mode: 'open', expect: good },
  { kind: 'call', actor: 'owner', operation: 'resume', expect: { ok: true, outcome: 'Committed' } },
  { kind: 'call', actor: 'owner', operation: 'refresh', expect: good },
  { kind: 'call', actor: 'owner', operation: 'acknowledge', expect: good },
  {
    kind: 'call',
    actor: 'peer',
    operation: 'refresh',
    expect: good,
  },
];
/** Complete actor execution + bounded artifacts. Expected text and old durable
 * bytes are independent reference observations, not production permissions.
 * Raw signed ledger and encrypted SQL outbox frames retain original bytes.
 * Secret fixture exports stay private IPC memory and do not enter evidence.json. */
export const runLabScenario = Effect.fn('Lab.runScenario')(function* (input: {
  readonly directory: string;
  readonly actions?: readonly unknown[];
  readonly actors?: readonly LabActorConfiguration[];
  readonly replaySource?: { readonly directory: string; readonly sha256: string };
  readonly sourceIndices?: readonly number[];
  readonly maxSteps?: number;
  readonly schedule?: readonly ScheduleChoice[];
  readonly stop?: Effect.Effect<void>;
}) {
  const directory = input.directory,
    actions = input.actions ?? existingWorkspaceActions,
    maxSteps = input.maxSteps ?? 256,
    stop = input.stop;
  const completed = yield* Effect.scoped(
    Effect.gen(function* () {
      const replayMaterial = input.replaySource
        ? loadPrivateReplay(input.replaySource.directory, input.replaySource.sha256)
        : undefined;
      const actorConfiguration = captureLabActors(replayMaterial?.actors ?? input.actors);
      const fixture = yield* makeLabScenarioFixture(
        join(directory, 'fixture'),
        actorConfiguration,
        replayMaterial
      );
      const exported = new Map<string, string>();
      for (const [label, device] of fixture.devices)
        exported.set(label, yield* exportDevice(device));
      const privateReplayDirectory = join(directory, 'private-replay');
      const privateReplay = savePrivateReplay(privateReplayDirectory, {
        format: 'lody-lab-private-replay/v1',
        syntheticOnly: true,
        actors: [...actorConfiguration],
        devices: Object.fromEntries(exported),
        initialRecords: fixture.initialRecords.map((record) => Buffer.from(record).toString('hex')),
      });
      const attackTransport = yield* makeLabAttackTransport({
        origin: fixture.host.baseUrl,
        genesis: fixture.genesis,
        maxEvents: 4096,
        maxBytes: 64 * 1024 * 1024,
      });
      const endpoints = new Map<string, string>();
      for (const { id } of actorConfiguration)
        endpoints.set(
          id,
          (yield* makeLabActorProxy({
            origin: fixture.host.baseUrl,
            fetch: attackTransport.fetchFor(id),
          })).baseUrl
        );
      const actors: Record<string, Effect.Success<ReturnType<typeof makeLabProcessActor>>> = {};
      for (const { id: label } of actorConfiguration)
        actors[label] = yield* makeLabProcessActor((mode) =>
          Effect.sync(() => ({
            syntheticOnly: true as const,
            targets: Object.fromEntries(
              [...fixture.devices].map(([id, device]) => [
                id,
                {
                  signingKey: Buffer.from(device.publicKey.toBytes()).toString('hex'),
                  membership: Buffer.from(fixture.memberships.get(id)!.toBytes()).toString('hex'),
                },
              ])
            ),
            initialKeyOwner: label === fixture.primary,
            epochRotation: true,
            privateReplayDirectory,
            replaySourceDirectory: input.replaySource?.directory,
            device: exported.get(label)!,
            baseUrl: endpoints.get(label)!,
            directory: fixture.directory,
            actor: label,
            mode,
            genesis: Buffer.from(fixture.genesis.toBytes()).toString('hex'),
            records: fixture.records.map((record) => Buffer.from(record).toString('hex')),
            point: {
              head: Buffer.from(fixture.point().head.toBytes()).toString('hex'),
              length: fixture.point().length,
            },
          }))
        );
      const implementation = yield* Effect.try({
        try: labImplementationIdentity,
        catch: (cause) => cause,
      });
      const org = Buffer.from(fixture.genesis.toBytes()).toString('hex');
      const trace = yield* makeLabContentTrace({ maxFacts: 256, maxTextBytes: 1024 * 1024 });
      const writerMeasurements: {
        action: number;
        expected: 'allow' | 'deny' | 'unmeasured';
        accepted: boolean;
        refusal?: { readonly tag: string; readonly code: string };
      }[] = [];
      const retainedInsiderViews = new Map<string, LedgerView>();
      for (const row of actorConfiguration)
        if (row.behavior === 'insider') retainedInsiderViews.set(row.id, fixture.view());
      const explicitMeasurements: Effect.Success<ReturnType<typeof measureLabScenarioProbes>>[] =
        [];
      const modelMeasurements: {
        action: number;
        prediction: RefActionPrediction;
        verdict: ReturnType<typeof judgeRefAction>;
        concurrent?: {
          action: LabAction;
          before: RefActionPrediction;
          atJoin: RefActionPrediction;
          beforePoint: { head: string; length: number };
          joinPoint: { head: string; length: number };
        };
      }[] = [];
      const pendingPredictions = new Map<
        string,
        {
          action: Extract<LabAction, { kind: 'call' }>;
          prediction: RefActionPrediction;
          point: { head: string; length: number };
        }
      >();
      let currentConcurrent: (typeof modelMeasurements)[number]['concurrent'];
      let currentPrediction: RefActionPrediction;
      let currentWrite: ReturnType<typeof refWriteExpectation> = 'unmeasured';
      let currentEpoch = 0;
      let observedActions = 0;
      const run = yield* executeLabActions({
        actors,
        measure: (action) =>
          measureLabScenarioProbes({
            fixture,
            trace,
            actor: action.actor,
            probes: action.probes,
            retained: retainedInsiderViews.get(action.actor),
            actorClosed: actors[action.actor]!.pid() === undefined,
          }).pipe(
            Effect.scoped,
            Effect.tap((measurement) =>
              Effect.sync(() => {
                explicitMeasurements.push(measurement);
              })
            )
          ),
        sourceIndices: input.sourceIndices,
        transport: attackTransport,
        mutateStorage: (action) =>
          applyLabStorageMutation(
            join(
              fixture.directory,
              action.store === 'host-mailbox'
                ? 'mailbox.sqlite'
                : action.store === 'host-stagedgroup'
                  ? 'epoch-staging.sqlite'
                  : action.store === 'host-streams'
                    ? 'riverrun.sqlite'
                    : `${action.actor}-${action.store}.sqlite`
            ),
            action.mutation,
            action.store === 'host-streams' ? fixture.genesis : undefined
          ),
        actions,
        maxSteps,
        stop,
        schedule: input.schedule,
        beforeAction: (action) =>
          Effect.sync(() => {
            currentConcurrent = undefined;
            const beforeView = fixture.view();
            const facts = refStateFromOrg(org, beforeView.inspectState());
            const deviceHex = Buffer.from(
              fixture.devices.get(action.actor)!.publicKey.toBytes()
            ).toString('hex');
            const target =
              'target' in action && action.target ? fixture.devices.get(action.target) : undefined;
            const targetDevice = target
              ? Buffer.from(target.publicKey.toBytes()).toString('hex')
              : undefined;
            currentPrediction = refActionPrediction({
              state: facts,
              actor: deviceHex,
              action,
              running: actors[action.actor]!.pid() !== undefined,
              targetDevice,
              targetUser: targetDevice ? facts.devices.get(targetDevice)?.user : undefined,
            });
            if (action.kind === 'begin-call') {
              const original = { ...action, kind: 'call' as const };
              pendingPredictions.set(action.id, {
                action: original,
                prediction: refActionPrediction({
                  state: facts,
                  actor: deviceHex,
                  action: original,
                  running: actors[action.actor]!.pid() !== undefined,
                  targetDevice,
                  targetUser: targetDevice ? facts.devices.get(targetDevice)?.user : undefined,
                }),
                point: {
                  head: Buffer.from(beforeView.head.toBytes()).toString('hex'),
                  length: beforeView.length,
                },
              });
            }
            if (action.kind === 'join-call') {
              const pending = pendingPredictions.get(action.id);
              if (pending) {
                const originalActor = pending.action.actor;
                const originalDevice = Buffer.from(
                  fixture.devices.get(originalActor)!.publicKey.toBytes()
                ).toString('hex');
                const originalTarget = pending.action.target
                  ? fixture.devices.get(pending.action.target)
                  : undefined;
                const originalTargetHex = originalTarget
                  ? Buffer.from(originalTarget.publicKey.toBytes()).toString('hex')
                  : undefined;
                const atJoin = refActionPrediction({
                  state: facts,
                  actor: originalDevice,
                  action: pending.action,
                  running: actors[originalActor]!.pid() !== undefined,
                  targetDevice: originalTargetHex,
                  targetUser: originalTargetHex
                    ? facts.devices.get(originalTargetHex)?.user
                    : undefined,
                });
                currentPrediction = pending.prediction;
                currentConcurrent = {
                  action: pending.action,
                  before: pending.prediction,
                  atJoin,
                  beforePoint: pending.point,
                  joinPoint: {
                    head: Buffer.from(beforeView.head.toBytes()).toString('hex'),
                    length: beforeView.length,
                  },
                };
              }
              pendingPredictions.delete(action.id);
            }
            currentWrite = refWriteExpectation(facts, deviceHex, org, facts.epoch);
            currentEpoch = facts.epoch;
          }),
        onObservation: (observation) =>
          Effect.gen(function* () {
            const action = observation.action;
            const observed = fixture.view();
            for (const row of actorConfiguration)
              if (
                row.behavior === 'insider' &&
                observed
                  .inspectState()
                  .devices.has(
                    Buffer.from(fixture.devices.get(row.id)!.publicKey.toBytes()).toString('hex')
                  )
              )
                retainedInsiderViews.set(row.id, observed);
            const index = observedActions++;
            modelMeasurements.push({
              action: index,
              prediction: currentPrediction,
              ...(currentConcurrent ? { concurrent: currentConcurrent } : {}),
              verdict: currentConcurrent
                ? judgeConcurrentRefAction(
                    currentConcurrent.before,
                    currentConcurrent.atJoin,
                    observation.reply,
                    refStateFromOrg(org, observed.inspectState())
                  )
                : judgeRefAction(
                    currentPrediction,
                    observation.reply,
                    refStateFromOrg(org, observed.inspectState())
                  ),
            });
            if (action.kind !== 'call' || action.operation !== 'append') return;
            const device = fixture.devices.get(action.actor)!.publicKey;
            const deviceHex = Buffer.from(device.toBytes()).toString('hex');
            // Facts come from independently witnessed original host records, not
            // from the child or the implementation's write-permission function.
            const expected = currentWrite;
            writerMeasurements.push({
              action: index,
              expected,
              accepted: observation.reply.ok,
              refusal: observation.reply.error,
            });
            if (observation.reply.ok)
              yield* trace.recordContentWrite({
                genesisHex: org,
                stream: action.document!,
                deviceHex,
                epoch: currentEpoch,
                text: action.text!,
                writerMayWrite: expected === 'unmeasured' ? undefined : expected === 'allow',
              });
          }),
      });
      const evidenceTransport = yield* makeLabSdkOwner(() => ({ close: async () => undefined }));
      const ciphertext: {
        stream: string;
        status: number;
        bodyHex: string;
        sha256: string;
        contentType: string | null;
        nextOffset: string | null;
        upToDate: boolean;
      }[] = [];
      for (const stream of ['loro', 'flock']) {
        const saved = yield* evidenceTransport.invoke(async () => {
          const response = await fetch(`${fixture.server.baseUrl}/ds/${org}/${stream}?offset=-1`, {
            signal: evidenceTransport.signal,
          });
          const bytes = response.body
            ? await readBoundedBody(response.body, 16 * 1024 * 1024)
            : new Uint8Array();
          if (bytes === undefined) throw new Error('evidence-stream-budget');
          return {
            stream,
            status: response.status,
            bodyHex: Buffer.from(bytes).toString('hex'),
            sha256: createHash('sha256').update(bytes).digest('hex'),
            contentType: response.headers.get('content-type'),
            nextOffset: response.headers.get('stream-next-offset'),
            upToDate: response.headers.get('stream-up-to-date') === 'true',
          };
        });
        ciphertext.push(saved);
      }
      // Native retention can make ordinary offset=-1 return 410 after a valid
      // snapshot. The insider property reads actual stored bytes in one read-only
      // transaction; it neither repairs retention nor supplies client authority.
      const backend = yield* observeLabBackendBytes({
        path: fixture.server.dbPath,
        genesis: fixture.genesis,
      });
      const attackObserver = yield* makeLabAttackObserver({
        maxFrames: 4096,
        genesis: fixture.genesis,
        backend: { read: () => Effect.succeed(backend.rows.map((row) => row.body)) },
        ledger: fixture.ledger,
        committedGroups: () =>
          Effect.gen(function* () {
            const rows = [];
            for (const [index, record] of fixture.records.entries()) {
              const parsed = Result.getOrThrow(decodeRecord(record));
              if (
                parsed.body.type !== 'ordinary' ||
                !['publishEpoch', 'removeMemberAndPublishEpoch'].includes(
                  parsed.body.operation.type
                )
              )
                continue;
              const view = Result.getOrThrow(
                verifyLedger({
                  anchor: fixture.genesis,
                  records: fixture.records.slice(0, index + 1),
                  checkpoint: { head: hashRecordBytes(record), length: index + 1 },
                })
              );
              const key = Result.getOrThrow(
                getCommittedEpochStagingKey(view, view.inspectState().epoch.number)
              );
              if (key) rows.push({ view, record, group: yield* fixture.staging.readGroup(key) });
            }
            return rows;
          }),
        trace,
      });
      const automaticMeasurement = yield* attackObserver.observe();
      const propertyMap = new Map(
        automaticMeasurement.properties.map((row) => [row.id, { ...row }])
      );
      for (const explicit of explicitMeasurements)
        for (const property of explicit.properties) {
          const prior = propertyMap.get(property.id);
          if (!prior || prior.verdict === 'unavailable')
            propertyMap.set(property.id, { ...property });
          else if (property.verdict !== 'unavailable')
            propertyMap.set(property.id, {
              id: property.id,
              verdict: worstVerdict([prior.verdict, property.verdict]),
            });
        }
      const writerVerdict = worstVerdict(writerMeasurements.map(judgeWriteObservation));
      propertyMap.set('integrity.author-write-permission', {
        id: 'integrity.author-write-permission',
        verdict: writerVerdict,
      });
      propertyMap.set('integrity.reference-model-agreement', {
        id: 'integrity.reference-model-agreement',
        verdict: worstVerdict(modelMeasurements.map((row) => row.verdict)),
      });
      propertyMap.set('integrity.full-ledger-verification', {
        id: 'integrity.full-ledger-verification',
        verdict: propertyMap.get('integrity.forged-control')?.verdict ?? 'unavailable',
      });
      propertyMap.set('durability.cursor-boundary-and-no-rollback', {
        id: 'durability.cursor-boundary-and-no-rollback',
        verdict: yield* measureLabCursors({
          path: fixture.server.dbPath,
          genesis: org,
          observations: run.observations,
        }),
      });
      propertyMap.set('durability.no-data-loss', {
        id: 'durability.no-data-loss',
        verdict: worstVerdict(
          run.observations.map((row) => row.durability).filter((value) => value !== 'unavailable')
        ),
      });
      propertyMap.set('confidentiality.excluded-device-and-member', {
        id: 'confidentiality.excluded-device-and-member',
        verdict:
          propertyMap.get('confidentiality.insider-post-exclusion')?.verdict ?? 'unavailable',
      });
      const properties = [...propertyMap.values()];
      const measured = {
        ...automaticMeasurement,
        properties,
        report: {
          integrity: worstVerdict(
            properties.filter((row) => row.id.startsWith('integrity.')).map((row) => row.verdict)
          ),
          durability: worstVerdict(
            properties.filter((row) => row.id.startsWith('durability.')).map((row) => row.verdict)
          ),
          confidentiality: worstVerdict(
            properties
              .filter((row) => row.id.startsWith('confidentiality.'))
              .map((row) => row.verdict)
          ),
        },
      };
      const { integrity, durability } = summarizeLabActions(run.observations);
      const writers = worstVerdict(writerMeasurements.map(judgeWriteObservation));
      const report = {
        integrity: worstVerdict([integrity, writers]),
        durability: worstVerdict([durability, measured.report.durability]),
        confidentiality: measured.report.confidentiality,
      };
      const artifacts = {
        version: 1,
        syntheticOnly: true,
        scope: 'existing-workspace finite action execution',
        privateReplay,
        actorConfiguration,
        identity: Object.fromEntries(
          [...fixture.devices].map(([id, device]) => [
            id,
            Buffer.from(device.publicKey.toBytes()).toString('hex'),
          ])
        ),
        implementation,
        ciphertext,
        rawTransportFiles: actorConfiguration.map(({ id }) => `fixture/${id}-transport.jsonl`),
        originals: fixture.records.map((record) => ({
          hex: Buffer.from(record).toString('hex'),
          sha256: createHash('sha256').update(record).digest('hex'),
        })),
        run: {
          ...run,
          verdict: worstVerdict([
            run.verdict,
            ...measured.properties
              .filter((row) => row.verdict !== 'unavailable')
              .map((row) => row.verdict),
          ]),
          properties: measured.properties,
        },
        measurements: {
          writerMeasurements,
          modelMeasurements,
          backend: { source: backend.source, metadata: backend.metadata },
          attacks: measured,
          explicitMeasurements,
          transport: yield* attackTransport.material(),
        },
        report,
        fingerprint: fingerprintOf(report),
        overallVerdict: worstVerdict([
          run.verdict,
          ...measured.properties.map((row) => row.verdict),
        ]),
        limits: [
          'Original-input replay does not replace the secure RNG or prove fresh-ciphertext equality',
          'Missing individual confidentiality/insider/context probes remain unavailable',
          'No production/native custody',
          'This action plan covers only its actual executed operations; production/native vault acceptance is separate',
        ],
      };
      for (const actor of Object.values(actors)) yield* actor.shutdown();
      return artifacts;
    })
  ).pipe(
    // This harness watchdog interrupts the whole owned scenario. Its Scope joins
    // actual child SIGKILL/close and native body cleanup before returning failure.
    Effect.timeoutOrElse({
      duration: '120 seconds',
      orElse: () => Effect.fail(new LabScenarioError({ code: 'watchdog' })),
    })
  );
  // Publish final evidence only after successful scenario completion and owner
  // cleanup. A hung shutdown must not leave a pass artifact for inspect.
  yield* Effect.try({
    try: () => {
      const body = JSON.stringify(completed, null, 2) + '\n';
      writeFileSync(join(directory, 'evidence.json'), body, { mode: 0o600, flag: 'wx' });
      if (readFileSync(join(directory, 'evidence.json'), 'utf8') !== body)
        throw new Error('evidence-readback');
    },
    catch: (cause) => cause,
  });
  return completed;
});
