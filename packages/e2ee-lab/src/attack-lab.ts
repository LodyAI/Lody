import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Effect } from 'effect';
import { toHex } from './platform/bytes';
import type { LabBackend } from './backend';
import { mutateSqliteBytes } from './attacks';
import { CONTROL_STREAM } from './platform/protocol';
import { judgeCursor, judgeImport, judgeLeak, type JudgeVerdict } from './judge';
import type { LabEvent } from './scheduler';
import { LabRuntime, type ProtocolFrame } from './runtime';

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

export interface HonestInspect {
  ledgerLength: number;
  expectedLength: number;
  cursor?: string | null;
  baselineCursor?: string | null;
  importFailed?: boolean;
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

async function measureHonest(state: PrivateState): Promise<HonestInspect> {
  if (state.inspectHonest) {
    try {
      const snapshot = await state.inspectHonest();
      return {
        ledgerLength: snapshot.ledgerLength,
        expectedLength: snapshot.expectedLength,
        importFailed: snapshot.importFailed === true,
      };
    } catch {
      return {
        ledgerLength: state.expectedLength,
        expectedLength: state.expectedLength,
        importFailed: true,
      };
    }
  }
  if (!state.genesisHex) {
    return { ledgerLength: state.expectedLength, expectedLength: state.expectedLength };
  }
  const response = await fetch(`${state.host.baseUrl}/ds/${state.genesisHex}/${CONTROL_STREAM}`);
  if (!response.ok) {
    return {
      ledgerLength: state.expectedLength,
      expectedLength: state.expectedLength,
      importFailed: true,
    };
  }
  const body = new Uint8Array(await response.arrayBuffer());
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let count = 0;
  let start = 0;
  while (body.byteLength - start >= 4) {
    const length = view.getUint32(start, false);
    if (length <= 0 || start + 4 + length > body.byteLength) break;
    count += 1;
    start += 4 + length;
  }
  return { ledgerLength: count, expectedLength: state.expectedLength };
}

function recordAction(state: PrivateState, action: AttackAction, replay = action): void {
  state.actions.push(action);
  state.replayActions.push(replay);
}

/** Harness-only: includes claim evidence. Not on the AttackLab capability object. */
export function harnessReplayActions(lab: AttackLab): readonly AttackAction[] {
  return [...(secrets.get(lab)?.replayActions ?? [])];
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
  return Effect.try({
    try: () => {
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
      while (remaining > 0) {
        const next = state.runtime.events().find((event) => event.status === 'requested');
        if (!next) break;
        state.runtime.permit(next.eventId);
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
              (input.actor === undefined || event.actor === input.actor)
          );
        if (hit) {
          state.runtime.permit(hit.eventId);
          return { ...publicView(state), unmet: false };
        }
        const next = state.runtime.events().find((event) => event.status === 'requested');
        if (!next) break;
        state.runtime.permit(next.eventId);
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
        const rejected = measured.importFailed || measured.ledgerLength <= measured.expectedLength;
        integrity = judgeImport({
          rejected,
          ledgerLength: measured.ledgerLength,
          expectedLength: measured.expectedLength,
        });
        durability = judgeCursor({
          rejected,
          cursorAdvancedPastBad: measured.ledgerLength > measured.expectedLength,
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

export async function replayAttackActions(
  lab: AttackLab,
  actions: readonly AttackAction[]
): Promise<PublicReport> {
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
      case 'mutateBackend':
        await lab.mutateBackend({
          eventId: String(action.input?.eventId ?? 'barrier'),
          kind: 'xor',
          needleHex: String(action.input?.needleHex ?? ''),
          xor: Number(action.input?.xor ?? 0xff),
        });
        break;
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
  return report;
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
