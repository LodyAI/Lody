type DirectoryPage = {
  checkpoint?: string;
  startPosition: number;
  totalCount: number;
  cursor: string | null;
  hasMoreOlder: boolean;
  rows: readonly { position: number; state: string; turnId?: string }[];
};

type OwnerResponse = {
  sessionId: string;
  success: boolean;
  result?: unknown;
  pageTurns?: unknown;
  historyRevision?: number;
  historyCount?: number;
  historyChange?: unknown;
  error?: string;
  retryReason?: 'superseded';
};

export function buildPendingUserHistoryEntry(args: {
  userId: string | undefined;
  inputBlocks: readonly Record<string, unknown>[];
  timestamp: string;
  inputConfig?: Record<string, unknown>;
  status?: 'pending' | 'pending_apply';
}): (Record<string, unknown> & { id?: never }) | null;
export const HistoryEntryWriteSchema: unknown;
export function parseHistoryWrite(
  schema: unknown,
  input: unknown,
): { id: string; [key: string]: unknown };

export function readSessionHistoryMetadata(reader: {
  readDirectory: (
    from: number,
    to: number,
  ) => Promise<
    readonly {
      scalars?: Record<string, unknown>;
      inputConfig?: unknown;
      userId?: string;
    }[]
  >;
}): Promise<Record<string, unknown>[]>;

export type RoostSessionData = ReturnType<
  ReturnType<typeof createRemoteRoostSessionDataFactory>
>;

export function createRemoteRoostSessionDataFactory(options: {
  accountId?: string | null;
  workspaceId: string;
  machineId: string;
  incremental?: boolean;
  watch?: boolean;
  coherentInspection?: boolean;
  patches?: boolean;
  active?: () => boolean;
  subscribeWake?: (wake: () => void) => () => void;
  requestHistoryRead: (
    machineId: string,
    sessionId: string,
    query: { kind: string; [key: string]: unknown },
  ) => Promise<OwnerResponse>;
  requestHistoryWrite: (args: {
    machineId: string;
    sessionId: string;
    operation: string;
    payload: Record<string, unknown>;
  }) => Promise<OwnerResponse>;
}): (args: { sessionId: string }) => {
  history: {
    count(): Promise<number>;
    observe: (listener: (change: unknown) => void) => {
      initial: Promise<unknown>;
      initialPage: Promise<DirectoryPage>;
      unsubscribe: () => void;
    };
    readLatestDirectoryPage: (limit: number) => Promise<DirectoryPage>;
    readOlderDirectoryPage: (
      cursor: string,
      limit: number,
    ) => Promise<DirectoryPage>;
    readTurn: (id: string) => Promise<{ state: string; turn?: unknown }>;
    readDirectory: (
      from: number,
      to: number,
    ) => Promise<
      readonly {
        scalars?: Record<string, unknown>;
        inputConfig?: unknown;
        userId?: string;
      }[]
    >;
  };
  inputAcceptance: {
    readonly targetMachineId?: string;
    accept(entry: {
      id: string;
      [key: string]: unknown;
    }): Promise<InputReceipt>;
    acceptAndDispatch(entry: {
      id: string;
      [key: string]: unknown;
    }): Promise<InputReceipt>;
    lookup(entry: {
      id: string;
      [key: string]: unknown;
    }): Promise<InputReceipt>;
  };
  commands: {
    applyHistoryAction(action: Record<string, unknown>): Promise<unknown>;
    replaceTurn(
      turnId: string,
      turn: { id: string; [key: string]: unknown },
    ): Promise<void>;
    respondPermission(
      requestId: string,
      outcome: Record<string, unknown>,
      options: { turnId: string },
    ): Promise<boolean>;
  };
  snapshots: {
    capture(): Promise<{ history: Record<string, unknown>[] }>;
  };
  dispose: () => void;
};

type CapabilityCarrier =
  | {
      protocolCapabilities?: Record<string, unknown>;
    }
  | null
  | undefined;

export function machineSupportsSessionHistoryProtocol(
  machine: CapabilityCarrier,
): boolean;
export function machineSupportsSessionHistoryIncremental(
  machine: CapabilityCarrier,
): boolean;
export function machineSupportsSessionHistoryWatch(
  machine: CapabilityCarrier,
): boolean;
export function machineSupportsSessionHistoryPatches(
  machine: CapabilityCarrier,
): boolean;
export function machineSupportsSessionHistoryInspection(
  machine: CapabilityCarrier,
): boolean;
export function machineSupportsSessionInputAcceptance(
  machine: CapabilityCarrier,
): boolean;
export function machineSupportsSessionInputDispatch(
  machine: CapabilityCarrier,
): boolean;

export function resolveNewSessionHistoryBackend(
  machine: { protocolCapabilities?: Record<string, number> } | null | undefined,
  options: { requested?: 'loro' | 'roost'; preferred?: 'loro' | 'roost' },
): 'loro' | 'roost';

export type AcceptedInput = {
  id: string;
  sessionId: string;
  workspaceId: string;
  targetMachineId: string;
  historyBackend: 'roost';
  entry: { id: string; [key: string]: unknown };
  delivery:
    | { kind: 'dispatch' | 'history' }
    | { kind: 'guide'; expectedTurnId: string };
  attachments: never[];
  sequence?: number;
  persisted?: boolean;
  inputState?: 'saving' | 'sending' | 'unknown' | 'confirmed';
  error?: string;
};
export type InputReceipt =
  | { status: 'unobserved' }
  | {
      status: 'accepted';
      turnId: string;
      active: boolean;
      dispatchHandled?: boolean;
    };
export class SessionInputNotSentError extends Error {}
export function createSessionInputStorage(
  accountId: string,
  workspaceId: string,
): unknown;
export function createAcceptedSessionInputs(ports: {
  resources: {
    run<T>(
      work: (signal: AbortSignal) => Promise<T>,
      signal?: AbortSignal,
      options?: { protectExit?: boolean },
    ): Promise<T>;
  };
  storage: unknown;
  lock<T>(
    sessionId: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T>;
  write(send: AcceptedInput, signal: AbortSignal): Promise<InputReceipt>;
  lookup(send: AcceptedInput, signal: AbortSignal): Promise<InputReceipt>;
  deliver(
    send: AcceptedInput,
    signal: AbortSignal,
    receipt: InputReceipt,
  ): Promise<void | InputReceipt>;
  visible(send: AcceptedInput, signal: AbortSignal): Promise<boolean>;
  confirmed?(send: AcceptedInput): void;
  unknownMessage(): string;
  changed?(): void;
}): {
  getSnapshot(): readonly AcceptedInput[];
  subscribe(listener: () => void): () => void;
  enqueue(send: AcceptedInput): void;
  retry(id: string): void;
  cancel(id: string): Promise<void>;
  cancelSessions(ids: Iterable<string>): Promise<void>;
  capturePredecessors(sessionId: string): Promise<readonly string[]>;
  afterInputs<T>(
    sessionId: string,
    ids: readonly string[],
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T>;
  acknowledgeLanded(ids: Iterable<string>): Promise<void>;
  resume(): Promise<void>;
  refresh(): Promise<void>;
  dispose(): Promise<void>;
};

export type SendMetadata = { exists: boolean; meta?: Record<string, unknown> };
export type MobileSendStore = {
  sessionData: RoostSessionData;
  getState(): Record<string, unknown>;
  setState(
    change: (draft: {
      humanInputReceipts?: Record<string, { userId: string }>;
    }) => void,
  ): void;
  waitUntilSynced(signal?: AbortSignal): Promise<void>;
};
export function createSessionOperationScope(): {
  run<T>(
    work: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    options?: { protectExit?: boolean },
  ): Promise<T>;
  dispose(): Promise<void>;
};
export type MobileSendPorts = {
  repo: { getDocMeta(roomId: string): Promise<SendMetadata | undefined> };
  writer: {
    upsertDocMeta(
      roomId: string,
      patch: { latestUserMsgId?: string },
    ): Promise<void>;
  };
  sendResources: {
    run: ReturnType<typeof createSessionOperationScope>['run'];
    withSessionStore<T>(
      sessionId: string,
      work: (store: MobileSendStore, signal: AbortSignal) => T | Promise<T>,
      signal?: AbortSignal,
    ): Promise<T>;
  };
  requestSessionSteer(
    machineId: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
  requestSessionDispatchTurn(
    machineId: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
};
export function createWorkspaceAcceptedInputs(options: {
  runtime: MobileSendPorts;
  runtimeForDelivery?(signal: AbortSignal): MobileSendPorts;
  accountId: string;
  workspaceId: string;
  validateLocalAttachments(send: AcceptedInput): Promise<void>;
  visible(send: AcceptedInput, signal: AbortSignal): Promise<boolean>;
  onGuideOutcome?(
    sessionId: string,
    inputId: string,
    expectedTurnId: string,
    applied: boolean | undefined,
  ): void;
}): ReturnType<typeof createAcceptedSessionInputs>;
