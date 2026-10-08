import type { SessionId, SessionMeta, WorkspaceId } from '@lody/shared';
import type {
  SessionDataChange,
  SessionDirectoryRow,
  SessionDirectoryScalars,
  SessionHistoryReader,
  SessionObservation,
} from '@lody/shared/session-data';
import { calculateTurnDurationMs, classifySessionTurnOutcome } from './session-output';
import type { SessionTurnOutcome } from './session-output';
import type { Writable } from 'node:stream';

export type ObservedTurn = {
  userTurnId: string;
  assistantTurnId?: string;
  state: 'pending' | 'running' | 'unknown' | SessionTurnOutcome;
  durationMs?: number;
};

export type ObservedSession = {
  sessionId: SessionId;
  machineId: SessionMeta['machineId'];
  title?: string;
  archived: boolean;
  state: 'idle' | 'pending' | 'running' | 'waiting' | 'unknown';
  freshness: 'synced' | 'unavailable';
  source: 'persisted' | 'metadata';
  latestTurn?: ObservedTurn;
  activeTurns: ObservedTurn[];
};

export type SessionObserveEvent =
  | { type: 'snapshot' | 'session.changed'; sessionId: SessionId; session: ObservedSession }
  | { type: 'turn.started'; sessionId: SessionId; userTurnId: string; assistantTurnId?: string }
  | {
      type: 'turn.finished';
      sessionId: SessionId;
      userTurnId: string;
      assistantTurnId?: string;
      outcome: SessionTurnOutcome;
      durationMs?: number;
    }
  | { type: 'session.removed'; sessionId: SessionId }
  | { type: 'ready'; sessionId?: SessionId }
  | { type: 'error'; error: string };

export type SessionObserveEnvelope = SessionObserveEvent & {
  version: 1;
  streamId: string;
  sequence: number;
  observedAt: number;
  workspaceId: WorkspaceId;
};

export function resolveObserveSelection(
  sessionIdArg: string | undefined,
  options: {
    workspace?: string;
    all?: boolean;
    follow?: boolean;
    jsonl?: boolean;
    json?: boolean;
    offline?: boolean;
  },
  envSessionId?: string
): { sessionId?: SessionId; all: boolean } {
  if (options.json && options.jsonl) throw new Error('Pass either --json or --jsonl, not both.');
  if (options.follow && !options.jsonl)
    throw new Error('Session observe --follow requires --jsonl.');
  if (options.follow && options.offline)
    throw new Error('--offline cannot follow live Session changes.');
  if (options.all) {
    if (!options.workspace?.trim())
      throw new Error('Workspace observation requires --workspace and --all.');
    if (sessionIdArg?.trim()) throw new Error('Pass a Session ID or --all, not both.');
    return { all: true };
  }
  const sessionId = sessionIdArg?.trim() || envSessionId?.trim();
  if (!sessionId)
    throw new Error('Missing session ID. Pass one explicitly or set LODY_SESSION_ID.');
  return { sessionId: sessionId as SessionId, all: false };
}

const isTerminal = (state: ObservedTurn['state']): state is SessionTurnOutcome =>
  state === 'completed' || state === 'failed' || state === 'canceled';

function projectTurn(
  user: SessionDirectoryScalars,
  assistant?: SessionDirectoryScalars
): ObservedTurn {
  const outcome = classifySessionTurnOutcome(user, assistant);
  const state =
    outcome ??
    (user.status === 'processing' ||
    (assistant && assistant.finished !== true && assistant.endedAt === undefined)
      ? 'running'
      : user.status && user.status !== 'handled' && user.status !== 'prepared'
        ? 'pending'
        : 'unknown');
  return {
    userTurnId: user.id,
    ...(assistant ? { assistantTurnId: assistant.id } : {}),
    state,
    ...(outcome && assistant ? { durationMs: calculateTurnDurationMs(assistant) } : {}),
  };
}

/** Command-owned reader. It never writes history, metadata, presence or unread state. */
export class SessionObserver {
  private readonly rows = new Map<number, SessionDirectoryRow>();
  private readonly positions = new Map<string, Set<number>>();
  private readonly users = new Map<string, SessionDirectoryRow>();
  private readonly assistants = new Map<string, Map<number, SessionDirectoryScalars>>();
  private readonly turns = new Map<string, ObservedTurn>();
  private readonly active = new Map<string, ObservedTurn>();
  private latestUser: SessionDirectoryRow | undefined;
  private readonly dirtyIds = new Set<string>();
  private structure: { from: number; to: number } | undefined;
  private observation: SessionObservation | undefined;
  private unsubscribeControl = () => {};
  private revision = 0;
  private requested = false;
  private running: Promise<void> | undefined;
  private closed = false;
  private initial = true;
  private initialized = false;
  private fresh: boolean;
  private snapshot: ObservedSession | undefined;
  private failure: unknown;

  constructor(
    private readonly options: {
      sessionId: SessionId;
      history: Pick<SessionHistoryReader, 'observe' | 'readDirectory'>;
      subscribeControl: (listener: () => void) => () => void;
      readMeta: () => Promise<SessionMeta | null>;
      fresh: boolean;
      emit: (event: SessionObserveEvent) => Promise<void>;
      onError: (error: unknown) => void;
      onRemoved?: () => void;
    }
  ) {
    this.fresh = options.fresh;
  }

  async start(): Promise<void> {
    try {
      this.observation = this.options.history.observe((change) => this.changed(change));
      this.unsubscribeControl = this.options.subscribeControl(() => this.refresh());
      for (const row of await this.observation.initial) this.replaceRow(row);
      this.requested = true;
      await this.drain();
      this.initialized = true;
      if (this.requested) this.run();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  get current(): ObservedSession | undefined {
    return this.snapshot;
  }

  refresh(): void {
    if (this.closed) return;
    this.revision += 1;
    this.requested = true;
    // Initial notifications are accumulated until the gap-free directory lands.
    if (!this.initialized) return;
    this.run();
  }

  setFreshness(fresh: boolean): void {
    if (this.fresh === fresh) return;
    this.fresh = fresh;
    this.refresh();
  }

  async flush(): Promise<void> {
    while (this.running) await this.running;
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.observation?.unsubscribe();
    this.unsubscribeControl();
    await this.running;
  }

  private changed(change: SessionDataChange): void {
    if (change.kind === 'changed') {
      for (const id of change.ids) this.dirtyIds.add(id);
    } else {
      this.structure = {
        from: Math.min(this.structure?.from ?? change.from, change.from),
        to: Math.max(this.structure?.to ?? change.to, change.to),
      };
    }
    this.refresh();
  }

  private run(): void {
    if (this.running || this.closed) return;
    this.running = this.drain()
      .catch((error: unknown) => {
        this.failure = error;
        this.closed = true;
        this.observation?.unsubscribe();
        this.unsubscribeControl();
        this.options.onError(error);
      })
      .finally(() => {
        this.running = undefined;
        if (this.requested && !this.closed) this.run();
      });
  }

  private replaceRow(row: SessionDirectoryRow): void {
    const previous = this.rows.get(row.position);
    if (previous?.scalars) {
      const scalar = previous.scalars;
      const positions = this.positions.get(scalar.id);
      positions?.delete(row.position);
      if (positions?.size === 0) this.positions.delete(scalar.id);
      if (scalar.role === 'user' && this.users.get(scalar.id)?.position === row.position) {
        this.users.delete(scalar.id);
        for (const position of positions ?? []) {
          const retained = this.rows.get(position);
          if (
            retained?.scalars?.role === 'user' &&
            (!this.users.has(scalar.id) || position < this.users.get(scalar.id)!.position)
          )
            this.users.set(scalar.id, retained);
        }
      }
      if (scalar.role === 'assistant' && scalar.userTurnId) {
        this.assistants.get(scalar.userTurnId)?.delete(row.position);
      }
    }
    if (row.state === 'missing') this.rows.delete(row.position);
    else this.rows.set(row.position, row);
    if (row.state !== 'ready' || !row.scalars) return;
    const scalar = row.scalars;
    let positions = this.positions.get(scalar.id);
    if (!positions) {
      positions = new Set();
      this.positions.set(scalar.id, positions);
    }
    positions.add(row.position);
    if (scalar.role === 'user') {
      // Match readTurnOutput: the first User copy owns a duplicated identity.
      if (!this.users.has(scalar.id) || row.position <= this.users.get(scalar.id)!.position)
        this.users.set(scalar.id, row);
      if (!this.latestUser || row.position >= this.latestUser.position) this.latestUser = row;
    }
    if (scalar.role === 'assistant' && scalar.userTurnId) {
      let linked = this.assistants.get(scalar.userTurnId);
      if (!linked) {
        linked = new Map();
        this.assistants.set(scalar.userTurnId, linked);
      }
      linked.set(row.position, scalar);
    }
  }

  private async drain(): Promise<void> {
    while (this.requested && !this.closed) {
      this.requested = false;
      const revision = this.revision;
      const structure = this.structure;
      const dirtyIds = [...this.dirtyIds];
      const affected = new Set<string>();
      const reads: SessionDirectoryRow[] = [];
      if (structure)
        reads.push(...(await this.options.history.readDirectory(structure.from, structure.to)));
      for (const id of dirtyIds) {
        for (const position of this.positions.get(id) ?? []) {
          if (!structure || position < structure.from) {
            reads.push(...(await this.options.history.readDirectory(position, position + 1)));
          }
        }
      }
      const meta = await this.options.readMeta();
      if (this.closed) return;
      if (revision !== this.revision) {
        this.requested = true;
        continue;
      }
      if (meta === null) {
        await this.options.emit({ type: 'session.removed', sessionId: this.options.sessionId });
        this.closed = true;
        this.observation?.unsubscribe();
        this.unsubscribeControl();
        this.options.onRemoved?.();
        return;
      }
      this.structure = undefined;
      this.dirtyIds.clear();
      if (structure) {
        const returned = new Set(reads.map((row) => row.position));
        for (const position of this.rows.keys()) {
          if (position >= structure.from && !returned.has(position)) {
            reads.push({ position, state: 'missing' });
          }
        }
      }
      for (const row of reads) {
        for (const scalars of [this.rows.get(row.position)?.scalars, row.scalars]) {
          if (scalars?.role === 'user') affected.add(scalars.id);
          if (scalars?.role === 'assistant' && scalars.userTurnId) affected.add(scalars.userTurnId);
        }
        this.replaceRow(row);
      }
      if (this.initial || structure) for (const id of this.users.keys()) affected.add(id);
      if (structure) {
        this.latestUser = [...this.rows.values()].reduce<SessionDirectoryRow | undefined>(
          (latest, row) =>
            row.scalars?.role === 'user' && (!latest || row.position > latest.position)
              ? row
              : latest,
          undefined
        );
      }
      const events: SessionObserveEvent[] = [];
      // Keep the last published turn state during loss of freshness. Catch-up
      // reconciles all scalar evidence, including outcomes that finished offline.
      if (this.fresh || this.initial) {
        if (this.snapshot?.freshness === 'unavailable' && this.fresh) {
          for (const id of this.users.keys()) affected.add(id);
          for (const id of this.turns.keys()) affected.add(id);
        }
        for (const id of [...affected].sort(
          (a, b) => (this.users.get(a)?.position ?? -1) - (this.users.get(b)?.position ?? -1)
        )) {
          const row = this.users.get(id);
          if (!row?.scalars) {
            this.turns.delete(id);
            this.active.delete(id);
            continue;
          }
          const assistant = [...(this.assistants.get(id)?.entries() ?? [])]
            .filter(([position]) => position > row.position)
            .sort(([a], [b]) => a - b)[0]?.[1];
          const next = projectTurn(row.scalars, assistant);
          const previous = this.turns.get(id);
          if (!this.initial) {
            const identity = {
              sessionId: this.options.sessionId,
              userTurnId: id,
              ...(next.assistantTurnId ? { assistantTurnId: next.assistantTurnId } : {}),
            };
            if (next.state === 'running' && previous?.state !== 'running') {
              events.push({ type: 'turn.started', ...identity });
            } else if (isTerminal(next.state) && previous?.state !== next.state) {
              events.push({
                type: 'turn.finished',
                ...identity,
                outcome: next.state,
                ...(next.durationMs !== undefined ? { durationMs: next.durationMs } : {}),
              });
            }
          }
          this.turns.set(id, next);
          if (next.state === 'pending' || next.state === 'running') this.active.set(id, next);
          else this.active.delete(id);
        }
      }
      const latestUser = this.latestUser;
      const latestTurn = latestUser?.scalars ? this.turns.get(latestUser.scalars.id) : undefined;
      const activeTurns = [...this.active.values()];
      const state = activeTurns.some((turn) => turn.state === 'running')
        ? meta.status?.type === 'requestPermission'
          ? 'waiting'
          : 'running'
        : activeTurns.length > 0
          ? 'pending'
          : (latestTurn && isTerminal(latestTurn.state)) || (!latestUser && !meta.latestUserMsgId)
            ? 'idle'
            : 'unknown';
      const snapshot: ObservedSession = {
        sessionId: this.options.sessionId,
        machineId: meta.machineId,
        ...(meta.title ? { title: meta.title } : {}),
        archived: meta.isArchived === true,
        state,
        source: 'persisted',
        freshness: this.fresh ? 'synced' : 'unavailable',
        ...(latestTurn ? { latestTurn } : {}),
        activeTurns,
      };
      if (JSON.stringify(this.snapshot) !== JSON.stringify(snapshot)) {
        events.push({
          type: this.initial ? 'snapshot' : 'session.changed',
          sessionId: this.options.sessionId,
          session: snapshot,
        });
      }
      this.snapshot = snapshot;
      this.initial = false;
      for (const event of events) {
        if (this.closed) return;
        await this.options.emit(event);
      }
    }
  }
}

/** A bounded, ordered JSONL sink shared by every Session in one command process. */
export function createSessionObserveWriter(options: {
  output: Writable;
  workspaceId: WorkspaceId;
  streamId: string;
  now: () => number;
  signal: AbortSignal;
}) {
  let sequence = 0;
  let queuedBytes = 0;
  let tail = Promise.resolve();
  return async (event: SessionObserveEvent): Promise<void> => {
    const envelope: SessionObserveEnvelope = {
      ...event,
      version: 1,
      streamId: options.streamId,
      sequence: ++sequence,
      observedAt: options.now(),
      workspaceId: options.workspaceId,
    };
    const line = `${JSON.stringify(envelope)}\n`;
    const bytes = Buffer.byteLength(line);
    if (queuedBytes + bytes > 1024 * 1024)
      throw new Error('Session observation output buffer exceeded 1 MiB.');
    queuedBytes += bytes;
    const write = tail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (options.signal.aborted) {
            reject(options.signal.reason);
            return;
          }
          const finish = (error?: Error | null, retainErrorListener = false) => {
            // Writable emits its error after invoking the failed write callback.
            // Keep the listener until that event so a closed pipe cannot crash cleanup.
            if (!retainErrorListener) options.output.off('error', onError);
            options.signal.removeEventListener('abort', onAbort);
            if (error) reject(error);
            else resolve();
          };
          const onError = (error: Error) => finish(error);
          const onAbort = () => finish(new Error('Session observation stopped.'));
          options.output.once('error', onError);
          options.signal.addEventListener('abort', onAbort, { once: true });
          try {
            options.output.write(line, (error) => finish(error, Boolean(error)));
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        })
    );
    tail = write.catch(() => {});
    try {
      await write;
    } finally {
      queuedBytes -= bytes;
    }
  };
}
