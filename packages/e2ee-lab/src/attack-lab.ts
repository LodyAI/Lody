import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Effect } from 'effect';
import { toHex } from './platform/bytes';
import type { LabBackend } from './backend';
import { mutateSqliteBytes, riverrunNextOffset, riverrunRecordCount } from './attacks';
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
  genesisHex: string | null;
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
};

const secrets = new WeakMap<AttackLab, PrivateState>();

function priv(lab: AttackLab): PrivateState {
  const state = secrets.get(lab);
  if (!state) throw new Error('attack-lab-invalid');
  if (state.closed) throw new Error('attack-lab-closed');
  return state;
}

function publicView(state: PrivateState): PublicView {
  return {
    events: state.runtime.events().map((event) => ({
      eventId: event.eventId,
      actor: event.actor,
      operation: event.operation,
      phase: event.phase,
      status: event.status,
    })),
    genesisHex: state.genesisHex,
    backendBytes: existsSync(state.host.riverrunDbPath)
      ? readFileSync(state.host.riverrunDbPath).byteLength
      : 0,
    errors: [...state.errors],
  };
}

function knownEvent(state: PrivateState, eventId: string): boolean {
  return state.runtime.events().some((event) => event.eventId === eventId);
}

function assertBudget(state: PrivateState): void {
  if (Date.now() - state.startedMs > state.maxMs) throw new Error('attack-budget-time');
}

/**
 * Real client measurement: live verified read, journal re-verification through
 * `Ledger.verify`, and document/cursor file consistency. Returns measured
 * facts; `finish` derives the verdicts.
 */
export function inspectClient(
  client: HonestClient,
  host: LabBackend
): () => Promise<HonestInspect> {
  return async () => {
    const genesisHex = client.genesisHex;
    if (!genesisHex) return { unmeasured: true };
    const facts: HonestInspect = {};
    try {
      facts.verifiedRecords = (await client.readLedger()).length;
    } catch {
      facts.importFailed = true;
    }
    const counted = await riverrunRecordCount(host.riverrunUrl, genesisHex, CONTROL_STREAM);
    if (counted.ok && facts.verifiedRecords !== undefined) {
      facts.rejectedRecords = Math.max(0, counted.count - facts.verifiedRecords);
    }
    // Re-verify every record the client durably holds; a stored record that
    // fails verification is a client-side unauthorized acceptance.
    const store = new SqliteLedgerStore(join(client.clientDir, 'ledger.sqlite'));
    let journal: { genesis: Uint8Array; records: readonly Uint8Array[] } | null = null;
    try {
      journal = await store.exclusive((tx) => tx.load());
    } catch {
      journal = null;
    }
    if (journal && journal.records.length > 0) {
      try {
        await Ledger.verify({ anchor: journal.genesis, records: journal.records });
        facts.unverifiedAccepted = 0;
      } catch {
        facts.unverifiedAccepted = journal.records.length;
      }
    } else {
      // Nothing durably held means nothing was accepted — still a fact.
      facts.unverifiedAccepted = 0;
    }
    facts.durableLoss =
      (facts.verifiedRecords !== undefined && facts.verifiedRecords > 0 && !journal) ||
      (await cursorFacts(client.clientDir, host, genesisHex)).loss;
    facts.cursorAhead = (await cursorFacts(client.clientDir, host, genesisHex)).ahead;
    return facts;
  };
}

/**
 * Does the persisted document still cover every version the cursor claims to
 * have consumed? A document rolled back to an older snapshot while keeping the
 * latest cursor fails this check. Returns undefined when it cannot be decided.
 */
function docCoversCursor(
  docPath: string,
  kind: string,
  claimed: Record<string, unknown>
): boolean | undefined {
  try {
    const bytes = readFileSync(docPath);
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
}

async function cursorFacts(
  clientDir: string,
  host: LabBackend,
  genesisHex: string
): Promise<{ ahead: boolean | undefined; loss: boolean }> {
  let ahead: boolean | undefined = false;
  let loss = false;
  for (const kind of [LORO_STREAM, FLOCK_STREAM] as const) {
    const cursorPath = kind === 'flock' ? flockCursorPath(clientDir) : loroCursorPath(clientDir);
    const docPath = kind === 'flock' ? flockDocPath(clientDir) : loroDocPath(clientDir);
    if (!existsSync(cursorPath)) continue;
    if (!existsSync(docPath)) {
      loss = true;
      continue;
    }
    let cursor: {
      streamUrl?: string;
      nextOffset?: string;
      serverLowerBoundVersion?: Record<string, unknown>;
    };
    try {
      cursor = JSON.parse(readFileSync(cursorPath, 'utf8')) as typeof cursor;
    } catch {
      loss = true;
      continue;
    }
    // The cursor must be bound to the persisted document: rolling the document
    // back to an older valid snapshot while keeping this cursor is a violation.
    const covered = docCoversCursor(docPath, kind, cursor.serverLowerBoundVersion ?? {});
    if (covered === false) ahead = true;
    else if (covered === undefined) ahead = undefined;
    const stream = cursor.streamUrl?.split('/').filter(Boolean).pop() ?? kind;
    try {
      const tail = await riverrunNextOffset(host.riverrunUrl, genesisHex, stream);
      if (cursor.nextOffset !== undefined && BigInt(cursor.nextOffset) > BigInt(tail)) {
        ahead = true;
      }
    } catch {
      ahead = undefined;
    }
  }
  return { ahead, loss };
}

async function measureHonest(state: PrivateState): Promise<HonestInspect> {
  if (!state.inspectHonest) return { unmeasured: true };
  try {
    return await state.inspectHonest();
  } catch {
    return { unmeasured: true };
  }
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

/**
 * Canonical cursor digest: protocol-meaningful fields only. `streamUrl` is
 * reduced to its path (the port is per-run) and wall-clock fields are dropped.
 */
function cursorDigest(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const cursor = JSON.parse(raw) as Record<string, unknown>;
    const url = typeof cursor.streamUrl === 'string' ? new URL(cursor.streamUrl) : null;
    return JSON.stringify({
      path: url?.pathname ?? null,
      nextOffset: cursor.nextOffset ?? null,
      serverLowerBoundVersion: cursor.serverLowerBoundVersion ?? null,
    });
  } catch {
    return 'unparseable';
  }
}

async function clientStateDigest(dir: string): Promise<ClientDigest> {
  let journal: { genesis: Uint8Array; records: readonly Uint8Array[] } | null = null;
  try {
    const store = new SqliteLedgerStore(join(dir, 'ledger.sqlite'));
    journal = await store.exclusive((tx) => tx.load());
  } catch {
    journal = null;
  }
  const hash = createHash('sha256');
  if (journal) {
    hash.update(journal.genesis);
    for (const record of journal.records) hash.update(record);
  }
  const fileDigest = (path: string): string | null => {
    try {
      return createHash('sha256').update(readFileSync(path)).digest('hex');
    } catch {
      return null;
    }
  };
  return {
    ledgerRecords: journal ? journal.records.length : null,
    ledgerHead: journal ? hash.digest('hex') : null,
    loroDoc: fileDigest(loroDocPath(dir)),
    flockDoc: fileDigest(flockDocPath(dir)),
    loroCursor: cursorDigest(loroCursorPath(dir)),
    flockCursor: cursorDigest(flockCursorPath(dir)),
  };
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
  for (const dir of state?.clientDirs ?? []) clients.push(await clientStateDigest(dir));
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
  genesisHex?: string | null;
  expectedLength?: number;
  inspectHonest?: () => Promise<HonestInspect>;
}): AttackLab {
  const lab: AttackLab = {
    observe: () => Effect.runPromise(observeEffect(lab)),
    advance: (body) => Effect.runPromise(advanceEffect(lab, body)),
    advanceUntil: (body) => Effect.runPromise(advanceUntilEffect(lab, body)),
    readBackend: (body) => Effect.runPromise(readBackendEffect(lab, body)),
    mutateBackend: (body) => Effect.runPromise(mutateBackendEffect(lab, body)),
    intercept: (body) => Effect.runPromise(interceptEffect(lab, body)),
    submitClaim: (body) => Effect.runPromise(submitClaimEffect(lab, body)),
    finish: () => Effect.runPromise(finishEffect(lab)),
    actions: () => [...(secrets.get(lab)?.actions ?? [])],
  };
  secrets.set(lab, {
    host: input.host,
    runtime: input.runtime,
    clientDirs: input.clientDirs.map((dir) => resolve(dir)),
    expectedPlaintext: input.expectedPlaintext,
    genesisHex: input.genesisHex ?? null,
    inspectHonest: input.inspectHonest,
    expectedLength: input.expectedLength ?? 1,
    errors: [],
    claims: [],
    actions: [],
    replayActions: [],
    startedMs: Date.now(),
    maxMs: 30_000,
    maxMutations: 16,
    mutations: 0,
    closed: false,
    hostClosed: false,
  });
  return lab;
}

function observeEffect(lab: AttackLab) {
  return Effect.tryPromise({
    try: async () => {
      const state = priv(lab);
      assertBudget(state);
      recordAction(state, { op: 'observe' });
      return publicView(state);
    },
    catch: (error) => error,
  });
}

function advanceEffect(lab: AttackLab, input: { steps: number }) {
  return Effect.try({
    try: () => {
      const state = priv(lab);
      assertBudget(state);
      recordAction(state, { op: 'advance', input });
      let remaining = Math.max(0, input.steps);
      while (remaining > 0 && state.runtime.permitNext() !== null) {
        remaining -= 1;
      }
      return publicView(state);
    },
    catch: (error) => error,
  });
}

function advanceUntilEffect(
  lab: AttackLab,
  input: { actor?: string; phase: string; maxSteps: number }
) {
  return Effect.try({
    try: () => {
      const state = priv(lab);
      assertBudget(state);
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
          return { ...publicView(state), unmet: false };
        }
        if (state.runtime.permitNext() === null) break;
      }
      return { ...publicView(state), unmet: true };
    },
    catch: (error) => error,
  });
}

function readBackendEffect(lab: AttackLab, input: BackendRead) {
  return Effect.try({
    try: () => {
      const state = priv(lab);
      assertBudget(state);
      recordAction(state, { op: 'readBackend', input: { ...input } });
      if (input.target !== 'riverrun') throw new Error('invalid-target');
      if (!knownEvent(state, input.eventId) && input.eventId !== 'barrier') {
        throw new Error('invalid-event');
      }
      const path = resolve(state.host.riverrunDbPath);
      for (const dir of state.clientDirs) {
        if (path === dir || path.startsWith(`${dir}/`)) throw new Error('invalid-target');
      }
      if (!existsSync(path)) throw new Error('backend-missing');
      return new Uint8Array(readFileSync(path));
    },
    catch: (error) => error,
  });
}

function mutateBackendEffect(lab: AttackLab, input: BackendMutation) {
  return Effect.tryPromise({
    try: async () => {
      const state = priv(lab);
      assertBudget(state);
      recordAction(state, { op: 'mutateBackend', input: { ...input } });
      if (input.kind !== 'xor') throw new Error('invalid-mutation');
      if (!knownEvent(state, input.eventId) && input.eventId !== 'barrier') {
        throw new Error('invalid-event');
      }
      if (state.mutations >= state.maxMutations) throw new Error('attack-budget-mutations');
      const path = resolve(state.host.riverrunDbPath);
      for (const dir of state.clientDirs) {
        if (path.startsWith(`${dir}/`) || path === dir) throw new Error('invalid-target');
      }
      if (!state.hostClosed) {
        await state.host.close();
        state.hostClosed = true;
      }
      const needle = fromHex(input.needleHex);
      state.mutations += 1;
      const ok = mutateSqliteBytes(path, needle, input.xor ?? 0xff);
      if (!ok) state.errors.push('mutation-miss');
      // Harness-only replay record: the receipt is compared on replay so a
      // needle that misses a different ciphertext is a divergence, not a pass.
      state.replayActions[state.replayActions.length - 1] = {
        op: 'mutateBackend',
        input: { ...input, receipt: ok },
      };
      return { ok };
    },
    catch: (error) => error,
  });
}

function interceptEffect(lab: AttackLab, input: ResponseMutation) {
  return Effect.try({
    try: () => {
      const state = priv(lab);
      assertBudget(state);
      recordAction(state, { op: 'intercept', input: { ...input } });
      if (!knownEvent(state, input.eventId)) throw new Error('invalid-event');
      state.runtime.intercept(input);
      return { ok: true };
    },
    catch: (error) => error,
  });
}

function submitClaimEffect(lab: AttackLab, input: AttackClaim) {
  return Effect.try({
    try: () => {
      const state = priv(lab);
      assertBudget(state);
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
    },
    catch: (error) => error,
  });
}

function finishEffect(lab: AttackLab) {
  return Effect.tryPromise({
    try: async () => {
      const state = secrets.get(lab);
      if (!state || state.closed) throw new Error('attack-lab-closed');
      recordAction(state, { op: 'finish' });
      state.closed = true;
      const disk = existsSync(state.host.riverrunDbPath)
        ? readFileSync(state.host.riverrunDbPath)
        : Buffer.alloc(0);
      const leaked = disk.includes(state.expectedPlaintext);
      const recovered = state.claims.some(
        (claim) => claim.kind === 'plaintext' && claim.evidence === state.expectedPlaintext
      );
      let reachable = false;
      try {
        reachable = (await fetch(`${state.host.baseUrl}/healthz`)).ok;
      } catch {
        reachable = false;
      }
      const confidentiality = judgeLeak({ backendContainsPlaintext: leaked || recovered });
      let integrity: JudgeVerdict = 'unavailable';
      let durability: JudgeVerdict = 'unavailable';
      if (reachable) {
        const measured = await measureHonest(state);
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
        budgetExceeded: Date.now() - state.startedMs > state.maxMs,
        claims: state.claims.length,
      };
    },
    catch: (error) => error,
  });
}

export interface ReplayOutcome {
  readonly report: PublicReport;
  /** First divergent event/entropy/frame/verdict, or null on an exact replay. */
  readonly divergence: Divergence | null;
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
    switch (action.op) {
      case 'observe':
        await lab.observe();
        break;
      case 'advance':
        await lab.advance({ steps: Number(action.input?.steps ?? 1) });
        break;
      case 'advanceUntil':
        await lab.advanceUntil({
          actor: action.input?.actor as string | undefined,
          phase: String(action.input?.phase ?? 'request-queued'),
          maxSteps: Number(action.input?.maxSteps ?? 8),
        });
        break;
      case 'readBackend':
        await lab.readBackend({
          target: 'riverrun',
          eventId: String(action.input?.eventId ?? 'barrier'),
        });
        break;
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
        break;
      }
      case 'intercept':
        await lab.intercept({
          eventId: String(action.input?.eventId ?? ''),
          kind: interceptKind(action.input?.kind),
          status: action.input?.status as number | undefined,
          bodyHex: action.input?.bodyHex as string | undefined,
        });
        break;
      case 'submitClaim':
        await lab.submitClaim({
          kind: (action.input?.kind as AttackClaim['kind']) ?? 'plaintext',
          evidence: action.input?.evidence as string | undefined,
        });
        break;
      case 'finish':
        report = await lab.finish();
        break;
      default:
        throw new Error(`unknown-action:${action.op}`);
    }
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
    for (const dir of state?.clientDirs ?? []) actualClients.push(await clientStateDigest(dir));
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
