import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Effect, Option, type Layer } from 'effect';
import { toHex } from './platform/bytes';
import type { LabBackend } from './backend';
import {
  mutateSqliteBytesEffect,
  riverrunNextOffsetEffect,
  riverrunRecordCountEffect,
} from './attacks';
import { CONTROL_STREAM, FLOCK_STREAM, KEYS_STREAM, LORO_STREAM } from './platform/protocol';
import {
  composeDurability,
  composeIntegrity,
  judgeClaim,
  judgeClientDurability,
  judgeInsiderLeak,
  judgeLeak,
  worstVerdict,
  type JudgeVerdict,
} from './judge';
import { insiderDecryptEffect, type InsiderFrame, type InsiderMaterial } from './insider';
import { canPermitEvent, type LabEvent } from './scheduler';
import { firstReplayDivergence, type Divergence } from './replay';
import { LabRuntime, type ProtocolFrame } from './runtime';
import { Bytes, verifyLedger } from '@lody/e2ee-core/effect';
import { signatureVerifierLayer } from '@lody/e2ee-core/effect/platform';
import { contentWritesFor } from './content-trace';
import { SqliteLedgerStore } from '@lody/e2ee-core/ledger-node';
import { LoroDoc, VersionVector } from 'loro-crdt';
import { Flock } from '@loro-dev/flock-wasm';
import type { HonestClient } from './actors';
import { flockCursorPath, flockDocPath, loroCursorPath, loroDocPath } from './platform/persist';
import {
  LabClock,
  LabFs,
  LabHttp,
  LiveLabLayer,
  runLabPromise,
  LabRun,
  type LabServices,
} from './services';

export interface PublicView {
  readonly events: readonly Pick<
    LabEvent,
    'eventId' | 'actor' | 'operation' | 'phase' | 'status'
  >[];
  readonly genesisHex: string | null;
  readonly backendBytes: number;
  readonly errors: readonly string[];
  /** Excluded parties whose retained keys the attacker now holds. */
  readonly insiders: readonly string[];
  /** Active per-client split views. */
  readonly views: readonly { readonly actor: string; readonly stream: string }[];
  readonly unmet?: boolean;
}

/** Stable property ids; each is judged separately so coverage is explicit. */
export const PROPERTY_IDS = [
  'confidentiality.backend-plaintext',
  'confidentiality.insider-post-exclusion',
  'integrity.ledger-verified',
  'integrity.content-authorized',
  'integrity.context-bound',
  'integrity.forged-claims',
  'durability.cursor-within-document',
  'durability.no-loss',
] as const;

export type PropertyId = (typeof PROPERTY_IDS)[number];

export interface PropertyVerdict {
  readonly id: PropertyId;
  readonly verdict: JudgeVerdict;
}

export interface PublicReport {
  readonly confidentiality: JudgeVerdict;
  readonly integrity: JudgeVerdict;
  readonly durability: JudgeVerdict;
  readonly detectability: JudgeVerdict;
  /**
   * One row per PROPERTY_IDS entry; `unavailable` rows are uncovered, not passes.
   * Always set by `finish`; absent only in reports built outside AttackLab.
   */
  readonly properties?: readonly PropertyVerdict[];
  readonly budgetExceeded: boolean;
  readonly claims: number;
}

export interface AttackAction {
  readonly op:
    | 'observe'
    | 'advance'
    | 'advanceUntil'
    | 'readBackend'
    | 'mutateBackend'
    | 'intercept'
    | 'forkView'
    | 'releaseView'
    | 'insiderRead'
    | 'submitClaim'
    | 'finish';
  readonly input?: Record<string, unknown>;
}

export interface BackendRead {
  readonly target: 'riverrun';
  readonly eventId: string;
}

export interface BackendMutation {
  readonly eventId: string;
  readonly kind: 'xor';
  readonly needleHex: string;
  readonly xor?: number;
}

export interface ResponseMutation {
  readonly eventId: string;
  readonly kind: 'drop' | 'replace' | 'delay' | 'duplicate' | 'truncate';
  readonly status?: number;
  readonly bodyHex?: string;
}

export interface AttackClaim {
  readonly kind: 'plaintext' | 'forged-accepted' | 'cursor-overrun';
  readonly evidence?: string;
}

export const VIEW_STREAMS = [CONTROL_STREAM, KEYS_STREAM, LORO_STREAM, FLOCK_STREAM] as const;

/** Withhold everything after the current tail of `stream` from `actor` only. */
export interface ViewFork {
  readonly eventId: string;
  readonly actor: string;
  readonly stream: (typeof VIEW_STREAMS)[number];
}

/** Harness-private content an excluded insider must not be able to decrypt. */
export interface ProtectedSecret {
  readonly text: string;
  readonly hiddenFrom: readonly string[];
}

export interface AttackLab {
  observe(): Promise<PublicView>;
  advance(input: { steps: number }): Promise<PublicView>;
  advanceUntil(input: { actor?: string; phase: string; maxSteps: number }): Promise<PublicView>;
  readBackend(input: BackendRead): Promise<Uint8Array>;
  mutateBackend(input: BackendMutation): Promise<{ ok: boolean }>;
  intercept(input: ResponseMutation): Promise<{ ok: boolean }>;
  forkView(input: ViewFork): Promise<{ at: number }>;
  releaseView(input: Omit<ViewFork, 'eventId'>): Promise<{ ok: boolean }>;
  /** Decrypt server-visible content with an exposed insider's retained keys. */
  insiderRead(input: { insider: string }): Promise<readonly InsiderFrame[]>;
  submitClaim(input: AttackClaim): Promise<{ received: true }>;
  finish(): Promise<PublicReport>;
  actions(): readonly AttackAction[];
}

/**
 * Measured client facts only — never security conclusions. Missing fields are
 * unmeasured observations, not passes.
 */
export interface HonestInspect {
  /** Verified records the client holds after a real read. */
  verifiedRecords?: number;
  /** Backend control-stream records the client fetched but refused to verify. */
  rejectedRecords?: number;
  /** Client-held journal records that fail re-verification (defective accept). */
  unverifiedAccepted?: number;
  /** Persisted cursor recorded progress beyond durable state. */
  cursorAhead?: boolean;
  /** Durable document/cursor data missing or inconsistent. */
  durableLoss?: boolean;
  /** Live import/verify of remote state failed. */
  importFailed?: boolean;
  /**
   * Client imported content whose writer lacked write rights at seal time
   * (independent reference model + lab write facts). Not "backend ciphertext
   * happens to decrypt". Later demotion of a former writer is not this flag.
   */
  unauthorizedContentAccepted?: boolean;
  /** Imported content could not be attributed to a write-time permission fact. */
  contentScanIncomplete?: boolean;
  /** Persisted journal genesis does not match the bound Org id. */
  wrongContextAccepted?: boolean;
  unmeasured?: boolean;
}

type PrivateState = {
  host: LabBackend;
  runtime: LabRuntime;
  clientDirs: readonly string[];
  expectedPlaintext: string;
  genesisHex: () => string | null;
  inspectHonest?: () => Promise<HonestInspect>;
  insiders: () => readonly InsiderMaterial[];
  protectedSecrets: () => readonly ProtectedSecret[];
  /** Streams any client was ever denied the tail of; survives releaseView. */
  forkedStreams: Set<string>;
  expectedLength: number;
  errors: string[];
  claims: AttackClaim[];
  actions: AttackAction[];
  replayActions: AttackAction[];
  startedMs: number;
  maxMs: number;
  maxMutations: number;
  mutations: number;
  closed: boolean;
  hostClosed: boolean;
  layer: Layer.Layer<LabServices, never, never>;
  run: LabRun<LabServices>;
};

const secrets = new WeakMap<AttackLab, PrivateState>();

function priv(lab: AttackLab): PrivateState {
  const state = secrets.get(lab);
  if (!state) throw new Error('attack-lab-invalid');
  if (state.closed) throw new Error('attack-lab-closed');
  return state;
}

function runLab<A>(lab: AttackLab, effect: Effect.Effect<A, unknown, LabServices>): Promise<A> {
  const state = secrets.get(lab);
  if (!state) throw new Error('attack-lab-invalid');
  return state.run.run(effect);
}

function publicViewEffect(state: PrivateState): Effect.Effect<PublicView, never, LabFs> {
  return Effect.gen(function* () {
    const fs = yield* LabFs;
    const path = state.host.riverrunDbPath;
    const backendBytes = fs.exists(path) ? fs.readBytes(path).byteLength : 0;
    return {
      events: state.runtime.events().map((event) => ({
        eventId: event.eventId,
        actor: event.actor,
        operation: event.operation,
        phase: event.phase,
        status: event.status,
      })),
      genesisHex: state.genesisHex(),
      backendBytes,
      errors: [...state.errors],
      insiders: state.insiders().map((insider) => insider.name),
      views: state.runtime.views().map(({ actor, stream }) => ({ actor, stream })),
    };
  });
}

function knownEvent(state: PrivateState, eventId: string): boolean {
  return state.runtime.events().some((event) => event.eventId === eventId);
}

function assertBudgetEffect(state: PrivateState): Effect.Effect<void, Error, LabClock> {
  return Effect.gen(function* () {
    const clock = yield* LabClock;
    if (clock.nowMs() - state.startedMs > state.maxMs) {
      yield* Effect.fail(new Error('attack-budget-time'));
    }
  });
}

/**
 * Real client measurement: live verified read, journal re-verification through
 * `verifyLedger`, and document/cursor file consistency. Returns measured
 * facts; `finish` derives the verdicts.
 *
 * Harness Promise entry uses LiveLabLayer. AttackLab `finish` may inject a
 * custom inspectHonest that already closed over services.
 */
export function inspectClient(
  client: HonestClient,
  host: LabBackend,
  layer: Layer.Layer<LabServices, never, never> = LiveLabLayer
): () => Promise<HonestInspect> {
  return () => runLabPromise(inspectClientEffect(client, host), layer);
}

function inspectClientEffect(
  client: HonestClient,
  host: LabBackend
): Effect.Effect<HonestInspect, unknown, LabServices> {
  return Effect.gen(function* () {
    const genesisHex = client.genesisHex;
    if (!genesisHex) return { unmeasured: true };
    const facts: HonestInspect = {};
    const ledger = yield* Effect.tryPromise({
      try: () => client.readLedger(),
      catch: (error) => error,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (ledger) facts.verifiedRecords = ledger.length;
    else facts.importFailed = true;
    const counted = yield* riverrunRecordCountEffect(
      host.riverrunUrl,
      genesisHex,
      CONTROL_STREAM
    ).pipe(Effect.catch(() => Effect.succeed({ ok: false as const, status: 0, count: 0 })));
    if (counted.ok && facts.verifiedRecords !== undefined) {
      facts.rejectedRecords = Math.max(0, counted.count - facts.verifiedRecords);
    }
    const store = new SqliteLedgerStore(join(client.clientDir, 'ledger.sqlite'));
    const journal = yield* store
      .exclusive((tx) => tx.load)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (journal && journal.records.length > 0) {
      const verified = yield* Effect.fromResult(Bytes.genesisHash(journal.genesis)).pipe(
        Effect.flatMap((anchor) => verifyLedger({ anchor, records: journal.records })),
        Effect.provide(signatureVerifierLayer),
        Effect.option
      );
      facts.unverifiedAccepted = Option.isNone(verified) ? journal.records.length : 0;
    } else {
      facts.unverifiedAccepted = 0;
    }
    if (journal && genesisHex) {
      facts.wrongContextAccepted = toHex(journal.genesis) !== genesisHex;
    }
    const cursors = yield* cursorFactsEffect(client.clientDir, host, genesisHex);
    facts.durableLoss =
      (facts.verifiedRecords !== undefined && facts.verifiedRecords > 0 && !journal) ||
      cursors.loss;
    facts.cursorAhead = cursors.ahead;
    const admitted = yield* importedUnauthorizedEffect(client, genesisHex);
    if (admitted === undefined) facts.contentScanIncomplete = true;
    else facts.unauthorizedContentAccepted = admitted;
    return facts;
  });
}

/**
 * Judge imported content from persisted Loro/Flock plus lab write facts.
 * Backend ciphertext that happens to decrypt is not acceptance. Writer rights
 * come from the independent reference model at seal time, not the current role.
 * Returns undefined when imported text cannot be attributed (unmeasured).
 */
function importedUnauthorizedEffect(
  client: HonestClient,
  genesisHex: string
): Effect.Effect<boolean | undefined, never, LabFs> {
  return Effect.gen(function* () {
    const fs = yield* LabFs;
    let loroText = '';
    let flockText = '';
    try {
      const loroPath = loroDocPath(client.clientDir);
      if (fs.exists(loroPath)) {
        const doc = new LoroDoc();
        try {
          doc.import(new Uint8Array(fs.readBytes(loroPath)));
          loroText = doc.getText('text').toString();
        } finally {
          doc.free();
        }
      }
    } catch {
      return undefined;
    }
    try {
      const flockPath = flockDocPath(client.clientDir);
      if (fs.exists(flockPath)) {
        const flock = Flock.fromFile(new Uint8Array(fs.readBytes(flockPath)), 'inspector');
        flockText = String(
          (flock.get(['private', 'note']) as { value?: string } | undefined)?.value ?? ''
        );
      }
    } catch {
      return undefined;
    }
    let unauthorized = false;
    let incomplete = false;
    for (const fact of contentWritesFor(genesisHex)) {
      const imported =
        fact.stream === 'flock' ? flockText.includes(fact.text) : loroText.includes(fact.text);
      if (!imported) continue;
      if (fact.writerMayWrite === undefined) {
        incomplete = true;
        continue;
      }
      if (fact.writerMayWrite === false) unauthorized = true;
    }
    if (incomplete) return undefined;
    return unauthorized;
  });
}

function docCoversCursorEffect(
  docPath: string,
  kind: string,
  claimed: Record<string, unknown>
): Effect.Effect<boolean | undefined, never, LabFs> {
  return Effect.gen(function* () {
    const fs = yield* LabFs;
    try {
      if (!fs.exists(docPath)) return undefined;
      const bytes = fs.readBytes(docPath);
      if (kind === FLOCK_STREAM) {
        const version = Flock.fromFile(new Uint8Array(bytes), 'inspector').inclusiveVersion();
        for (const [peer, entry] of Object.entries(claimed)) {
          const seen = version[peer];
          const want = entry as { physicalTime?: number; logicalCounter?: number } | undefined;
          if (
            !seen ||
            typeof want?.physicalTime !== 'number' ||
            typeof want?.logicalCounter !== 'number' ||
            seen.physicalTime < want.physicalTime ||
            (seen.physicalTime === want.physicalTime && seen.logicalCounter < want.logicalCounter)
          ) {
            return false;
          }
        }
        return true;
      }
      const doc = new LoroDoc();
      let version: VersionVector | undefined;
      try {
        doc.import(new Uint8Array(bytes));
        version = doc.oplogVersion();
        const claimedVector = new VersionVector(
          new Map(
            Object.entries(claimed).map(([peer, counter]) => [
              peer as `${number}`,
              counter as number,
            ])
          )
        );
        const order = version.compare(claimedVector);
        claimedVector.free();
        return order !== undefined && order >= 0;
      } finally {
        version?.free();
        doc.free();
      }
    } catch {
      return undefined;
    }
  });
}

function cursorFactsEffect(
  clientDir: string,
  host: LabBackend,
  genesisHex: string
): Effect.Effect<{ ahead: boolean | undefined; loss: boolean }, unknown, LabFs | LabHttp> {
  return Effect.gen(function* () {
    const fs = yield* LabFs;
    let ahead: boolean | undefined = false;
    let loss = false;
    for (const kind of [LORO_STREAM, FLOCK_STREAM] as const) {
      const cursorPath = kind === 'flock' ? flockCursorPath(clientDir) : loroCursorPath(clientDir);
      const docPath = kind === 'flock' ? flockDocPath(clientDir) : loroDocPath(clientDir);
      if (!fs.exists(cursorPath)) continue;
      if (!fs.exists(docPath)) {
        loss = true;
        continue;
      }
      let cursor: {
        streamUrl?: string;
        nextOffset?: string;
        serverLowerBoundVersion?: Record<string, unknown>;
      };
      try {
        cursor = JSON.parse(fs.readText(cursorPath)) as typeof cursor;
      } catch {
        loss = true;
        continue;
      }
      const covered = yield* docCoversCursorEffect(
        docPath,
        kind,
        cursor.serverLowerBoundVersion ?? {}
      );
      if (covered === false) ahead = true;
      else if (covered === undefined) ahead = undefined;
      const stream = cursor.streamUrl?.split('/').filter(Boolean).pop() ?? kind;
      const tail = yield* riverrunNextOffsetEffect(host.riverrunUrl, genesisHex, stream).pipe(
        Effect.catch(() => Effect.succeed(null as string | null))
      );
      if (tail === null) {
        ahead = undefined;
      } else if (cursor.nextOffset !== undefined && BigInt(cursor.nextOffset) > BigInt(tail)) {
        ahead = true;
      }
    }
    return { ahead, loss };
  });
}

function measureHonest(state: PrivateState): Effect.Effect<HonestInspect> {
  return Effect.promise(async () => {
    if (!state.inspectHonest) return { unmeasured: true };
    try {
      return await state.inspectHonest();
    } catch {
      return { unmeasured: true };
    }
  });
}

function recordAction(state: PrivateState, action: AttackAction, replay = action): void {
  state.actions.push(action);
  state.replayActions.push(replay);
}

/** Harness-only: includes claim evidence. Not on the AttackLab capability object. */
export function harnessReplayActions(lab: AttackLab): readonly AttackAction[] {
  return [...(secrets.get(lab)?.replayActions ?? [])];
}

/** Harness-private digest of one honest client's durable state. */
export interface ClientDigest {
  readonly ledgerRecords: number | null;
  readonly ledgerHead: string | null;
  readonly loroDoc: string | null;
  readonly flockDoc: string | null;
  readonly loroCursor: string | null;
  readonly flockCursor: string | null;
}

function cursorDigestEffect(path: string): Effect.Effect<string | null, never, LabFs> {
  return Effect.gen(function* () {
    const fs = yield* LabFs;
    if (!fs.exists(path)) return null;
    try {
      const cursor = JSON.parse(fs.readText(path)) as Record<string, unknown>;
      const url = typeof cursor.streamUrl === 'string' ? new URL(cursor.streamUrl) : null;
      return JSON.stringify({
        path: url?.pathname ?? null,
        nextOffset: cursor.nextOffset ?? null,
        serverLowerBoundVersion: cursor.serverLowerBoundVersion ?? null,
      });
    } catch {
      return 'unparseable';
    }
  });
}

function clientStateDigestEffect(dir: string): Effect.Effect<ClientDigest, unknown, LabFs> {
  return Effect.gen(function* () {
    const fs = yield* LabFs;
    let journal: { genesis: Uint8Array; records: readonly Uint8Array[] } | null = null;
    journal = yield* Effect.suspend(() =>
      new SqliteLedgerStore(join(dir, 'ledger.sqlite')).exclusive((tx) => tx.load)
    ).pipe(Effect.catch(() => Effect.succeed(null)));
    const hash = createHash('sha256');
    if (journal) {
      hash.update(journal.genesis);
      for (const record of journal.records) hash.update(record);
    }
    const fileDigest = (path: string): string | null => {
      if (!fs.exists(path)) return null;
      try {
        return createHash('sha256').update(fs.readBytes(path)).digest('hex');
      } catch {
        return null;
      }
    };
    return {
      ledgerRecords: journal ? journal.records.length : null,
      ledgerHead: journal ? hash.digest('hex') : null,
      loroDoc: fileDigest(loroDocPath(dir)),
      flockDoc: fileDigest(flockDocPath(dir)),
      loroCursor: yield* cursorDigestEffect(loroCursorPath(dir)),
      flockCursor: yield* cursorDigestEffect(flockCursorPath(dir)),
    };
  });
}

export interface ReplayMaterial {
  readonly actions: readonly AttackAction[];
  readonly events: readonly LabEvent[];
  readonly frames: readonly ProtocolFrame[];
  readonly clients: readonly ClientDigest[];
}

/**
 * Harness-only replay bundle: actions with claim evidence plus the scheduler
 * events, protocol frames, and honest-client state digests the run produced.
 * Never exposed to the attacker.
 */
export async function harnessReplayMaterial(lab: AttackLab): Promise<ReplayMaterial> {
  const state = secrets.get(lab);
  const clients: ClientDigest[] = [];
  if (state) {
    for (const dir of state.clientDirs) {
      clients.push(await state.run.run(clientStateDigestEffect(dir)));
    }
  }
  return {
    actions: [...(state?.replayActions ?? [])],
    events: [...(state?.runtime.events() ?? [])],
    frames: [...(state?.runtime.frames ?? [])],
    clients,
  };
}

export function createAttackLab(input: {
  host: LabBackend;
  runtime: LabRuntime;
  clientDirs: readonly string[];
  expectedPlaintext: string;
  /** Static value, or a getter when the space is created after the lab. */
  genesisHex?: string | null | (() => string | null);
  expectedLength?: number;
  inspectHonest?: () => Promise<HonestInspect>;
  /** Insiders exposed so far (excluded parties now colluding with the server). */
  insiders?: () => readonly InsiderMaterial[];
  /** Content each insider must not decrypt; judged at finish. */
  protectedSecrets?: () => readonly ProtectedSecret[];
  /** Harness-set attacker wall-clock budget; the attacker cannot extend it. */
  maxMs?: number;
  maxMutations?: number;
  /** Side-effect adapters; defaults to Live Node fs/fetch/clock. */
  layer?: Layer.Layer<LabServices, never, never>;
}): AttackLab {
  const layer = input.layer ?? LiveLabLayer;
  const lab: AttackLab = {
    observe: () => runLab(lab, observeEffect(lab)),
    advance: (body) => runLab(lab, advanceEffect(lab, body)),
    advanceUntil: (body) => runLab(lab, advanceUntilEffect(lab, body)),
    readBackend: (body) => runLab(lab, readBackendEffect(lab, body)),
    mutateBackend: (body) => runLab(lab, mutateBackendEffect(lab, body)),
    intercept: (body) => runLab(lab, interceptEffect(lab, body)),
    forkView: (body) => runLab(lab, forkViewEffect(lab, body)),
    releaseView: (body) => runLab(lab, releaseViewEffect(lab, body)),
    insiderRead: (body) => runLab(lab, insiderReadEffect(lab, body)),
    submitClaim: (body) => runLab(lab, submitClaimEffect(lab, body)),
    finish: () => runLab(lab, finishEffect(lab)),
    actions: () => [...(secrets.get(lab)?.actions ?? [])],
  };
  // startedMs is set after providing clock from the same layer.
  const run = new LabRun(layer);
  // finish seals the attacker handle; private replay measurement still belongs
  // to the enclosing harness run. Dispose only after the runtime is finished.
  input.runtime.addFinalizer(Effect.promise(() => run.close()));
  const startedMs = run.runSync(
    Effect.gen(function* () {
      const clock = yield* LabClock;
      return clock.nowMs();
    })
  );
  secrets.set(lab, {
    host: input.host,
    runtime: input.runtime,
    clientDirs: input.clientDirs.map((dir) => resolve(dir)),
    expectedPlaintext: input.expectedPlaintext,
    genesisHex:
      typeof input.genesisHex === 'function'
        ? input.genesisHex
        : () => (input.genesisHex as string | null | undefined) ?? null,
    inspectHonest: input.inspectHonest,
    insiders: input.insiders ?? (() => []),
    protectedSecrets: input.protectedSecrets ?? (() => []),
    forkedStreams: new Set(),
    expectedLength: input.expectedLength ?? 1,
    errors: [],
    claims: [],
    actions: [],
    replayActions: [],
    startedMs,
    maxMs: input.maxMs ?? 30_000,
    maxMutations: input.maxMutations ?? 16,
    mutations: 0,
    closed: false,
    hostClosed: false,
    layer,
    run,
  });
  return lab;
}

function observeEffect(lab: AttackLab): Effect.Effect<PublicView, unknown, LabServices> {
  return Effect.gen(function* () {
    const state = priv(lab);
    yield* assertBudgetEffect(state);
    recordAction(state, { op: 'observe' });
    return yield* publicViewEffect(state);
  });
}

function advanceEffect(
  lab: AttackLab,
  input: { steps: number }
): Effect.Effect<PublicView, unknown, LabServices> {
  return Effect.gen(function* () {
    const state = priv(lab);
    yield* assertBudgetEffect(state);
    recordAction(state, { op: 'advance', input });
    let remaining = Math.max(0, input.steps);
    while (remaining > 0 && state.runtime.permitNext() !== null) {
      remaining -= 1;
    }
    return yield* publicViewEffect(state);
  });
}

function advanceUntilEffect(
  lab: AttackLab,
  input: { actor?: string; phase: string; maxSteps: number }
): Effect.Effect<PublicView, unknown, LabServices> {
  return Effect.gen(function* () {
    const state = priv(lab);
    yield* assertBudgetEffect(state);
    recordAction(state, { op: 'advanceUntil', input });
    for (let i = 0; i < input.maxSteps; i++) {
      const hit = state.runtime
        .events()
        .find(
          (event) =>
            event.phase === input.phase &&
            event.status === 'requested' &&
            (input.actor === undefined || event.actor === input.actor) &&
            canPermitEvent(state.runtime.state, event.eventId)
        );
      if (hit) {
        state.runtime.permit(hit.eventId);
        return { ...(yield* publicViewEffect(state)), unmet: false };
      }
      if (state.runtime.permitNext() === null) break;
    }
    return { ...(yield* publicViewEffect(state)), unmet: true };
  });
}

function readBackendEffect(
  lab: AttackLab,
  input: BackendRead
): Effect.Effect<Uint8Array, unknown, LabServices> {
  return Effect.gen(function* () {
    const state = priv(lab);
    yield* assertBudgetEffect(state);
    recordAction(state, { op: 'readBackend', input: { ...input } });
    if (input.target !== 'riverrun') return yield* Effect.fail(new Error('invalid-target'));
    if (!knownEvent(state, input.eventId) && input.eventId !== 'barrier') {
      return yield* Effect.fail(new Error('invalid-event'));
    }
    const path = resolve(state.host.riverrunDbPath);
    for (const dir of state.clientDirs) {
      if (path === dir || path.startsWith(`${dir}/`)) {
        return yield* Effect.fail(new Error('invalid-target'));
      }
    }
    const fs = yield* LabFs;
    if (!fs.exists(path)) return yield* Effect.fail(new Error('backend-missing'));
    return new Uint8Array(fs.readBytes(path));
  });
}

function mutateBackendEffect(
  lab: AttackLab,
  input: BackendMutation
): Effect.Effect<{ ok: boolean }, unknown, LabServices> {
  return Effect.gen(function* () {
    const state = priv(lab);
    yield* assertBudgetEffect(state);
    recordAction(state, { op: 'mutateBackend', input: { ...input } });
    if (input.kind !== 'xor') return yield* Effect.fail(new Error('invalid-mutation'));
    if (!knownEvent(state, input.eventId) && input.eventId !== 'barrier') {
      return yield* Effect.fail(new Error('invalid-event'));
    }
    if (state.mutations >= state.maxMutations) {
      return yield* Effect.fail(new Error('attack-budget-mutations'));
    }
    const path = resolve(state.host.riverrunDbPath);
    for (const dir of state.clientDirs) {
      if (path.startsWith(`${dir}/`) || path === dir) {
        return yield* Effect.fail(new Error('invalid-target'));
      }
    }
    if (!state.hostClosed) {
      yield* Effect.tryPromise({
        try: () => state.host.close(),
        catch: (error) => error,
      });
      state.hostClosed = true;
    }
    const needle = fromHex(input.needleHex);
    state.mutations += 1;
    const ok = yield* mutateSqliteBytesEffect(path, needle, input.xor ?? 0xff);
    if (!ok) state.errors.push('mutation-miss');
    state.replayActions[state.replayActions.length - 1] = {
      op: 'mutateBackend',
      input: { ...input, receipt: ok },
    };
    return { ok };
  });
}

function interceptEffect(
  lab: AttackLab,
  input: ResponseMutation
): Effect.Effect<{ ok: boolean }, unknown, LabServices> {
  return Effect.gen(function* () {
    const state = priv(lab);
    yield* assertBudgetEffect(state);
    recordAction(state, { op: 'intercept', input: { ...input } });
    if (!knownEvent(state, input.eventId)) {
      return yield* Effect.fail(new Error('invalid-event'));
    }
    state.runtime.intercept(input);
    return { ok: true };
  });
}

function knownActor(state: PrivateState, actor: string): boolean {
  return actor !== 'script' && state.runtime.events().some((event) => event.actor === actor);
}

function forkViewEffect(
  lab: AttackLab,
  input: ViewFork
): Effect.Effect<{ at: number }, unknown, LabServices> {
  return Effect.gen(function* () {
    const state = priv(lab);
    yield* assertBudgetEffect(state);
    recordAction(state, { op: 'forkView', input: { ...input } });
    if (!(VIEW_STREAMS as readonly string[]).includes(input.stream)) {
      return yield* Effect.fail(new Error('invalid-stream'));
    }
    if (!knownEvent(state, input.eventId) && input.eventId !== 'barrier') {
      return yield* Effect.fail(new Error('invalid-event'));
    }
    if (!knownActor(state, input.actor)) return yield* Effect.fail(new Error('invalid-actor'));
    const genesisHex = state.genesisHex();
    if (!genesisHex) return yield* Effect.fail(new Error('no-space'));
    const tail = yield* riverrunNextOffsetEffect(state.host.riverrunUrl, genesisHex, input.stream);
    const at = Math.max(0, Number(tail));
    state.runtime.freezeView({ actor: input.actor, stream: input.stream, at });
    state.forkedStreams.add(input.stream);
    state.replayActions[state.replayActions.length - 1] = {
      op: 'forkView',
      input: { ...input, receipt: at },
    };
    return { at };
  });
}

function releaseViewEffect(
  lab: AttackLab,
  input: Omit<ViewFork, 'eventId'>
): Effect.Effect<{ ok: boolean }, unknown, LabServices> {
  return Effect.gen(function* () {
    const state = priv(lab);
    yield* assertBudgetEffect(state);
    recordAction(state, { op: 'releaseView', input: { ...input } });
    const held = state.runtime
      .views()
      .some((row) => row.actor === input.actor && row.stream === input.stream);
    state.runtime.releaseView(input.actor, input.stream);
    return { ok: held };
  });
}

function insiderReadEffect(
  lab: AttackLab,
  input: { insider: string }
): Effect.Effect<readonly InsiderFrame[], unknown, LabServices> {
  return Effect.gen(function* () {
    const state = priv(lab);
    yield* assertBudgetEffect(state);
    recordAction(state, { op: 'insiderRead', input: { ...input } });
    const insider = state.insiders().find((row) => row.name === input.insider);
    if (!insider) return yield* Effect.fail(new Error('invalid-insider'));
    const genesisHex = state.genesisHex();
    if (!genesisHex) return yield* Effect.fail(new Error('no-space'));
    const frames = yield* insiderDecryptEffect({
      riverrunUrl: state.host.riverrunUrl,
      genesisHex,
      insider,
    });
    if (frames === null) return yield* Effect.fail(new Error('backend-unreadable'));
    return frames;
  });
}

/**
 * Decrypt with every exposed insider's keys and look for content protected from
 * that insider. Also honours plaintext claims naming a protected secret.
 */
function insiderLeakEffect(
  state: PrivateState
): Effect.Effect<{ observed: boolean; leaked: boolean }, never, LabServices> {
  return Effect.gen(function* () {
    const insiders = state.insiders();
    const protectedSecrets = state.protectedSecrets();
    const genesisHex = state.genesisHex();
    if (insiders.length === 0 || protectedSecrets.length === 0 || !genesisHex) {
      return { observed: false, leaked: false };
    }
    let leaked = state.claims.some(
      (claim) =>
        claim.kind === 'plaintext' &&
        protectedSecrets.some((secret) => secret.text === claim.evidence)
    );
    for (const insider of insiders) {
      const hidden = protectedSecrets.filter((secret) => secret.hiddenFrom.includes(insider.name));
      if (hidden.length === 0) continue;
      const frames = yield* insiderDecryptEffect({
        riverrunUrl: state.host.riverrunUrl,
        genesisHex,
        insider,
      });
      if (frames === null) return { observed: false, leaked };
      const text = frames.map((frame) => frame.text).join('\n');
      if (hidden.some((secret) => text.includes(secret.text))) leaked = true;
    }
    return { observed: true, leaked };
  });
}

function submitClaimEffect(
  lab: AttackLab,
  input: AttackClaim
): Effect.Effect<{ received: true }, unknown, LabServices> {
  return Effect.gen(function* () {
    const state = priv(lab);
    yield* assertBudgetEffect(state);
    recordAction(
      state,
      {
        op: 'submitClaim',
        input: { kind: input.kind, evidence: input.evidence ? '[redacted]' : undefined },
      },
      { op: 'submitClaim', input: { kind: input.kind, evidence: input.evidence } }
    );
    state.claims.push(input);
    return { received: true as const };
  });
}

function finishEffect(lab: AttackLab): Effect.Effect<PublicReport, unknown, LabServices> {
  return Effect.gen(function* () {
    const state = secrets.get(lab);
    if (!state || state.closed) return yield* Effect.fail(new Error('attack-lab-closed'));
    recordAction(state, { op: 'finish' });
    state.closed = true;
    const fs = yield* LabFs;
    const clock = yield* LabClock;
    const http = yield* LabHttp;
    const disk = fs.exists(state.host.riverrunDbPath)
      ? fs.readBytes(state.host.riverrunDbPath)
      : new Uint8Array();
    const leaked = Buffer.from(disk).includes(state.expectedPlaintext);
    const plaintextClaimed = state.claims.some(
      (claim) => claim.kind === 'plaintext' && claim.evidence === state.expectedPlaintext
    );
    // An exposed insider may legitimately derive pre-exclusion content (history packets),
    // so a claim alone no longer proves a breach; plaintext on disk still does.
    const recovered = plaintextClaimed && state.insiders().length === 0;
    let reachable = false;
    const health = yield* Effect.tryPromise({
      try: () => http.fetch(`${state.host.baseUrl}/healthz`),
      catch: (error) => error,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (health) reachable = health.ok;
    const backendPlaintext = judgeLeak({ backendContainsPlaintext: leaked || recovered });
    const insider = yield* insiderLeakEffect(state);
    const insiderVerdict = judgeInsiderLeak({
      ...insider,
      freshnessBypassed:
        state.forkedStreams.has(CONTROL_STREAM) || state.forkedStreams.has(KEYS_STREAM),
    });
    const confidentiality = worstVerdict([backendPlaintext, insiderVerdict]);
    const properties: Record<PropertyId, JudgeVerdict> = {
      'confidentiality.backend-plaintext': backendPlaintext,
      'confidentiality.insider-post-exclusion': insiderVerdict,
      'integrity.ledger-verified': 'unavailable',
      'integrity.content-authorized': 'unavailable',
      'integrity.context-bound': 'unavailable',
      'integrity.forged-claims': 'unavailable',
      'durability.cursor-within-document': 'unavailable',
      'durability.no-loss': 'unavailable',
    };
    let integrity: JudgeVerdict = 'unavailable';
    let durability: JudgeVerdict = 'unavailable';
    let detectability: JudgeVerdict = worstVerdict([
      leaked || recovered ? 'violation' : 'pass',
      insiderVerdict,
    ]);
    if (reachable) {
      const measured = yield* measureHonest(state);
      const observed =
        !measured.unmeasured &&
        measured.unverifiedAccepted !== undefined &&
        measured.cursorAhead !== undefined &&
        measured.durableLoss !== undefined;
      const claimInputs = state.claims.map((claim) => ({
        kind: claim.kind,
        plaintextRecovered:
          claim.kind === 'plaintext' &&
          claim.evidence === state.expectedPlaintext &&
          state.insiders().length === 0,
        unverifiedAccepted: measured.unverifiedAccepted,
        cursorAhead: measured.cursorAhead === true,
      }));
      integrity = composeIntegrity({
        observed,
        acceptedUnauthorized: (measured.unverifiedAccepted ?? 0) > 0,
        unauthorizedContentAccepted: measured.unauthorizedContentAccepted,
        contentScanIncomplete: measured.contentScanIncomplete,
        wrongContextAccepted: measured.wrongContextAccepted,
        claims: claimInputs,
      });
      durability = composeDurability({
        observed,
        cursorAheadOfDocument: measured.cursorAhead === true,
        lostDurableData: measured.durableLoss === true,
        claims: claimInputs,
      });
      for (const claim of claimInputs) {
        if (claim.kind !== 'plaintext') continue;
        const claimed = judgeClaim(claim);
        if (claimed === 'violation') {
          detectability = 'violation';
          break;
        }
      }
      if (measured.unauthorizedContentAccepted && detectability !== 'violation') {
        detectability = 'outside-model';
      }
      if (observed) {
        properties['integrity.ledger-verified'] =
          (measured.unverifiedAccepted ?? 0) > 0 ? 'violation' : 'pass';
        properties['integrity.content-authorized'] = measured.contentScanIncomplete
          ? 'harness-error'
          : measured.unauthorizedContentAccepted === undefined
            ? 'unavailable'
            : measured.unauthorizedContentAccepted
              ? 'outside-model'
              : 'pass';
        properties['integrity.context-bound'] =
          measured.wrongContextAccepted === undefined
            ? 'unavailable'
            : measured.wrongContextAccepted
              ? 'violation'
              : 'pass';
        const forged = claimInputs.filter((claim) => claim.kind === 'forged-accepted');
        if (forged.length > 0)
          properties['integrity.forged-claims'] = worstVerdict(forged.map(judgeClaim));
        properties['durability.cursor-within-document'] = judgeClientDurability({
          observed: true,
          cursorAheadOfDocument: measured.cursorAhead === true,
          lostDurableData: false,
        });
        properties['durability.no-loss'] = judgeClientDurability({
          observed: true,
          cursorAheadOfDocument: false,
          lostDurableData: measured.durableLoss === true,
        });
      }
    }
    return {
      confidentiality,
      integrity,
      durability,
      detectability,
      properties: PROPERTY_IDS.map((id) => ({ id, verdict: properties[id] })),
      budgetExceeded: clock.nowMs() - state.startedMs > state.maxMs,
      claims: state.claims.length,
    };
  });
}

export interface ReplayOutcome {
  readonly report: PublicReport;
  /** First divergent event/entropy/frame/verdict, or null on an exact replay. */
  readonly divergence: Divergence | null;
}

/**
 * Apply one recorded attack action against a lab. Returns the report when the
 * action is `finish`. Shared by replayAttackActions and scenario drivers so
 * recorded actions execute through the same single implementation.
 */
export async function applyAttackAction(
  lab: AttackLab,
  action: AttackAction
): Promise<PublicReport | undefined> {
  switch (action.op) {
    case 'observe':
      await lab.observe();
      return undefined;
    case 'advance':
      await lab.advance({ steps: Number(action.input?.steps ?? 1) });
      return undefined;
    case 'advanceUntil':
      await lab.advanceUntil({
        actor: action.input?.actor as string | undefined,
        phase: String(action.input?.phase ?? 'request-queued'),
        maxSteps: Number(action.input?.maxSteps ?? 8),
      });
      return undefined;
    case 'readBackend':
      await lab.readBackend({
        target: 'riverrun',
        eventId: String(action.input?.eventId ?? 'barrier'),
      });
      return undefined;
    case 'mutateBackend': {
      const result = await lab.mutateBackend({
        eventId: String(action.input?.eventId ?? 'barrier'),
        kind: 'xor',
        needleHex: String(action.input?.needleHex ?? ''),
        xor: Number(action.input?.xor ?? 0xff),
      });
      const receipt = action.input?.receipt;
      if (receipt !== undefined && result.ok !== receipt) {
        throw new Error(
          `replay-divergence:mutateBackend:${String(action.input?.needleHex)}:expected:${String(receipt)}:actual:${result.ok}`
        );
      }
      return undefined;
    }
    case 'intercept':
      await lab.intercept({
        eventId: String(action.input?.eventId ?? ''),
        kind: interceptKind(action.input?.kind),
        status: action.input?.status as number | undefined,
        bodyHex: action.input?.bodyHex as string | undefined,
      });
      return undefined;
    case 'forkView': {
      const result = await lab.forkView({
        eventId: String(action.input?.eventId ?? 'barrier'),
        actor: String(action.input?.actor ?? ''),
        stream: String(action.input?.stream ?? CONTROL_STREAM) as ViewFork['stream'],
      });
      const receipt = action.input?.receipt;
      if (receipt !== undefined && result.at !== receipt) {
        throw new Error(
          `replay-divergence:forkView:${String(action.input?.stream)}:expected:${String(receipt)}:actual:${result.at}`
        );
      }
      return undefined;
    }
    case 'releaseView':
      await lab.releaseView({
        actor: String(action.input?.actor ?? ''),
        stream: String(action.input?.stream ?? CONTROL_STREAM) as ViewFork['stream'],
      });
      return undefined;
    case 'insiderRead':
      await lab.insiderRead({ insider: String(action.input?.insider ?? '') });
      return undefined;
    case 'submitClaim':
      await lab.submitClaim({
        kind: (action.input?.kind as AttackClaim['kind']) ?? 'plaintext',
        evidence: action.input?.evidence as string | undefined,
      });
      return undefined;
    case 'finish':
      return lab.finish();
    default:
      throw new Error(`unknown-action:${action.op}`);
  }
}

export async function replayAttackActions(
  lab: AttackLab,
  actions: readonly AttackAction[],
  expected?: {
    events?: readonly LabEvent[];
    frames?: readonly ProtocolFrame[];
    clients?: readonly ClientDigest[];
    report?: PublicReport;
  }
): Promise<ReplayOutcome> {
  let report: PublicReport | undefined;
  for (const action of actions) {
    report = (await applyAttackAction(lab, action)) ?? report;
  }
  if (!report) report = await lab.finish();
  let divergence: Divergence | null = null;
  const state = secrets.get(lab);
  if (expected?.events) {
    divergence = firstReplayDivergence(
      { events: expected.events, frames: [], entropy: [] },
      { events: state?.runtime.events() ?? [], frames: [], entropy: [] }
    );
  }
  if (!divergence && expected?.frames) {
    divergence = firstReplayDivergence(
      { events: [], frames: expected.frames, entropy: [] },
      { events: [], frames: state?.runtime.frames ?? [], entropy: [] }
    );
  }
  if (!divergence && expected?.clients) {
    const actualClients: ClientDigest[] = [];
    if (state) {
      for (const dir of state.clientDirs) {
        actualClients.push(await state.run.run(clientStateDigestEffect(dir)));
      }
    }
    const count = Math.max(expected.clients.length, actualClients.length);
    for (let index = 0; index < count && !divergence; index++) {
      const expectedClient = expected.clients[index];
      const actualClient = actualClients[index];
      if (!expectedClient || !actualClient) {
        divergence = {
          index,
          field: 'client',
          expected: expectedClient ? 'present' : 'missing',
          actual: actualClient ? 'present' : 'missing',
        };
        break;
      }
      for (const key of [
        'ledgerRecords',
        'ledgerHead',
        'loroDoc',
        'flockDoc',
        'loroCursor',
        'flockCursor',
      ] as const) {
        if (expectedClient[key] !== actualClient[key]) {
          divergence = {
            index,
            field: `client.${key}`,
            expected: String(expectedClient[key]),
            actual: String(actualClient[key]),
          };
          break;
        }
      }
    }
  }
  if (!divergence && expected?.report) divergence = firstReportDivergence(expected.report, report);
  return { report, divergence };
}

/** First differing verdict, including per-property rows. */
export function firstReportDivergence(
  expected: PublicReport,
  actual: PublicReport
): Divergence | null {
  for (const field of ['confidentiality', 'integrity', 'durability', 'detectability'] as const) {
    if (actual[field] !== expected[field]) {
      return {
        index: 0,
        field: `verdict.${field}`,
        expected: String(expected[field]),
        actual: String(actual[field]),
      };
    }
  }
  const byId = new Map((actual.properties ?? []).map((row) => [row.id, row.verdict]));
  for (const [index, row] of (expected.properties ?? []).entries()) {
    if (byId.get(row.id) !== row.verdict) {
      return {
        index,
        field: `property.${row.id}`,
        expected: row.verdict,
        actual: String(byId.get(row.id)),
      };
    }
  }
  return null;
}

function interceptKind(kind: unknown): ResponseMutation['kind'] {
  if (
    kind === 'replace' ||
    kind === 'delay' ||
    kind === 'duplicate' ||
    kind === 'drop' ||
    kind === 'truncate'
  ) {
    return kind;
  }
  return 'drop';
}

function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) throw new Error('invalid-hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.byteLength; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export type { ProtocolFrame };
export { toHex };
