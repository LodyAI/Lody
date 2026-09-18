import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Effect, type Layer } from 'effect';
import { toHex } from './platform/bytes';
import type { LabBackend } from './backend';
import {
  mutateSqliteBytesEffect,
  riverrunNextOffsetEffect,
  riverrunRecordCountEffect,
} from './attacks';
import { CONTROL_STREAM, FLOCK_STREAM, LORO_STREAM } from './platform/protocol';
import { judgeClientDurability, judgeClientIntegrity, judgeLeak, type JudgeVerdict } from './judge';
import { canPermitEvent, type LabEvent } from './scheduler';
import { firstReplayDivergence, type Divergence } from './replay';
import { LabRuntime, type ProtocolFrame } from './runtime';
import { Ledger } from '@lody/e2ee-core/ledger';
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
  readonly unmet?: boolean;
}

export interface PublicReport {
  readonly confidentiality: JudgeVerdict;
  readonly integrity: JudgeVerdict;
  readonly durability: JudgeVerdict;
  readonly detectability: JudgeVerdict;
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

export interface AttackLab {
  observe(): Promise<PublicView>;
  advance(input: { steps: number }): Promise<PublicView>;
  advanceUntil(input: { actor?: string; phase: string; maxSteps: number }): Promise<PublicView>;
  readBackend(input: BackendRead): Promise<Uint8Array>;
  mutateBackend(input: BackendMutation): Promise<{ ok: boolean }>;
  intercept(input: ResponseMutation): Promise<{ ok: boolean }>;
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
  unmeasured?: boolean;
}

type PrivateState = {
  host: LabBackend;
  runtime: LabRuntime;
  clientDirs: readonly string[];
  expectedPlaintext: string;
  genesisHex: () => string | null;
  inspectHonest?: () => Promise<HonestInspect>;
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
  return runLabPromise(effect, state.layer);
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
      return yield* Effect.fail(new Error('attack-budget-time'));
    }
  });
}

/**
 * Real client measurement: live verified read, journal re-verification through
 * `Ledger.verify`, and document/cursor file consistency. Returns measured
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
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (ledger) facts.verifiedRecords = ledger.length;
    else facts.importFailed = true;
    const counted = yield* riverrunRecordCountEffect(
      host.riverrunUrl,
      genesisHex,
      CONTROL_STREAM
    ).pipe(Effect.catchAll(() => Effect.succeed({ ok: false as const, status: 0, count: 0 })));
    if (counted.ok && facts.verifiedRecords !== undefined) {
      facts.rejectedRecords = Math.max(0, counted.count - facts.verifiedRecords);
    }
    const store = new SqliteLedgerStore(join(client.clientDir, 'ledger.sqlite'));
    const journal = yield* Effect.tryPromise({
      try: () => store.exclusive((tx) => tx.load()),
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (journal && journal.records.length > 0) {
      const verified = yield* Effect.tryPromise({
        try: () => Ledger.verify({ anchor: journal.genesis, records: journal.records }),
        catch: (error) => error,
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));
      facts.unverifiedAccepted = verified === null ? journal.records.length : 0;
    } else {
      facts.unverifiedAccepted = 0;
    }
    const cursors = yield* cursorFactsEffect(client.clientDir, host, genesisHex);
    facts.durableLoss =
      (facts.verifiedRecords !== undefined && facts.verifiedRecords > 0 && !journal) ||
      cursors.loss;
    facts.cursorAhead = cursors.ahead;
    return facts;
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
        Effect.catchAll(() => Effect.succeed(null as string | null))
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
    journal = yield* Effect.tryPromise({
      try: () => {
        const store = new SqliteLedgerStore(join(dir, 'ledger.sqlite'));
        return store.exclusive((tx) => tx.load());
      },
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
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
      clients.push(await runLabPromise(clientStateDigestEffect(dir), state.layer));
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
    submitClaim: (body) => runLab(lab, submitClaimEffect(lab, body)),
    finish: () => runLab(lab, finishEffect(lab)),
    actions: () => [...(secrets.get(lab)?.actions ?? [])],
  };
  // startedMs is set after providing clock from the same layer.
  const startedMs = Effect.runSync(
    Effect.gen(function* () {
      const clock = yield* LabClock;
      return clock.nowMs();
    }).pipe(Effect.provide(layer))
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
    const recovered = state.claims.some(
      (claim) => claim.kind === 'plaintext' && claim.evidence === state.expectedPlaintext
    );
    let reachable = false;
    const health = yield* Effect.tryPromise({
      try: () => http.fetch(`${state.host.baseUrl}/healthz`),
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (health) reachable = health.ok;
    const confidentiality = judgeLeak({ backendContainsPlaintext: leaked || recovered });
    let integrity: JudgeVerdict = 'unavailable';
    let durability: JudgeVerdict = 'unavailable';
    if (reachable) {
      const measured = yield* measureHonest(state);
      integrity = judgeClientIntegrity({
        observed: !measured.unmeasured && measured.unverifiedAccepted !== undefined,
        acceptedUnauthorized: (measured.unverifiedAccepted ?? 0) > 0,
      });
      durability = judgeClientDurability({
        observed:
          !measured.unmeasured &&
          measured.cursorAhead !== undefined &&
          measured.durableLoss !== undefined,
        cursorAheadOfDocument: measured.cursorAhead === true,
        lostDurableData: measured.durableLoss === true,
      });
    }
    return {
      confidentiality,
      integrity,
      durability,
      detectability: (leaked || recovered ? 'violation' : 'pass') as JudgeVerdict,
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
        actualClients.push(await runLabPromise(clientStateDigestEffect(dir), state.layer));
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
  if (!divergence && expected?.report) {
    for (const field of ['confidentiality', 'integrity', 'durability', 'detectability'] as const) {
      if (report[field] !== expected.report[field]) {
        divergence = {
          index: 0,
          field: `verdict.${field}`,
          expected: String(expected.report[field]),
          actual: String(report[field]),
        };
        break;
      }
    }
  }
  return { report, divergence };
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
