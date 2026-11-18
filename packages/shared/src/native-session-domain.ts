import type {
  MessageQueueItem,
  MessageQueueItemInput,
  SessionDocMeta,
  SessionExternalHistoryCursorDocState,
  SessionHistoryInput,
  SessionId,
  SessionPreviewDocState,
} from './index';
import type {
  SessionHistoryReader,
  SessionHistoryCommands,
  SessionTurn,
  SessionDataChange,
  SessionDirectoryRow,
} from './session-data';

/** Session bodies only. Workspace Meta and execution authority remain owned by
 * their existing services; no document, engine, patch or storage path crosses. */
export type NativeSessionScope = {
  readonly registrationId: string;
  readonly sessionId: SessionId;
  readonly requestId: string;
};
export type NativeSessionFrontiers = readonly {
  readonly peer: `${number}`;
  readonly counter: number;
}[];
export type NativeSessionControlState = Omit<SessionDocMeta, 'history'>;
export type NativeSessionRead =
  | { readonly kind: 'count' | 'all' | 'control' | 'frontiers' | 'directorySnapshot' | 'flush' }
  | { readonly kind: 'at'; readonly position: number }
  | { readonly kind: 'turn' | 'display' | 'output'; readonly turnId: string }
  | {
      readonly kind: 'run';
      readonly turnId: string;
      readonly sessionId: string;
      readonly runId: string;
    }
  | { readonly kind: 'range' | 'directory'; readonly from: number; readonly to: number };
export type NativeSessionCommand =
  | { readonly kind: 'append' | 'dispatchUserTurn'; readonly turn: SessionTurn }
  | { readonly kind: 'replace'; readonly turnId: string; readonly turn: SessionTurn }
  | {
      readonly kind: 'action';
      readonly action: Parameters<SessionHistoryCommands['applyHistoryAction']>[0];
    }
  | {
      readonly kind: 'permission';
      readonly requestId: string;
      readonly outcome: Parameters<SessionHistoryCommands['respondPermission']>[1];
      readonly options?: { readonly turnId?: string };
    }
  | {
      readonly kind: 'editableTail';
      readonly input: Parameters<SessionHistoryCommands['replaceEditableTail']>[0];
    }
  | { readonly kind: 'rollbackTail' | 'releaseRollback'; readonly token: string }
  | {
      readonly kind: 'import';
      readonly input: Parameters<SessionHistoryCommands['applyHistoryImport']>[0];
    }
  | { readonly kind: 'capture' }
  | { readonly kind: 'copy'; readonly token: string; readonly selection: readonly SessionTurn[] }
  | { readonly kind: 'releaseSnapshot'; readonly token: string }
  | { readonly kind: 'humanReceipt'; readonly inputId: string }
  | { readonly kind: 'queuePush'; readonly item: MessageQueueItemInput }
  | {
      readonly kind: 'queueUpdate';
      readonly cid: string;
      readonly patch: Partial<MessageQueueItem>;
    }
  | { readonly kind: 'queueRemove'; readonly cid: string }
  | { readonly kind: 'queueReorder'; readonly cids: readonly string[] }
  | { readonly kind: 'cancel'; readonly id: string; readonly turnId: string }
  | { readonly kind: 'preview'; readonly value: SessionPreviewDocState }
  | { readonly kind: 'externalCursor'; readonly value: SessionExternalHistoryCursorDocState };
export type NativeSessionEvent = NativeSessionScope & {
  readonly generation: string;
  readonly leaseId: string;
} & (
    | { readonly kind: 'history'; readonly change: SessionDataChange }
    | { readonly kind: 'control' }
    | {
        readonly kind: 'error';
        readonly code: 'access_denied' | 'restart_required' | 'operation_failed';
      }
  );
export type NativeSessionReadReply = { readonly generation: string; readonly result: unknown };
export type NativeSessionObserveReply = {
  readonly generation: string;
  readonly leaseId: string;
  readonly initial: readonly SessionDirectoryRow[];
  readonly control: NativeSessionControlState;
};
export type NativeSessionCapturedSnapshot = {
  readonly token: string;
  readonly history: readonly SessionHistoryInput[];
};
export type NativeSessionDomainTransport = {
  read(
    request: NativeSessionScope & {
      readonly query: NativeSessionRead;
      readonly expectedGeneration?: string;
    }
  ): Promise<NativeSessionReadReply>;
  execute(
    request: NativeSessionScope & {
      readonly command: NativeSessionCommand;
      readonly expectedGeneration: string;
    }
  ): Promise<NativeSessionReadReply>;
  observe(request: NativeSessionScope): Promise<NativeSessionObserveReply>;
  unobserve(
    request: NativeSessionScope & { readonly leaseId: string }
  ): Promise<{ readonly released: true }>;
  cancelObservation(request: NativeSessionScope): Promise<{ readonly canceled: true }>;
  subscribe(listener: (event: NativeSessionEvent) => void): () => void;
};
export type NativeSessionHistoryQueries = SessionHistoryReader;
/** Trusted Node port implemented once beside the Session owner. Main can depend
 * on this narrow contract without importing an application or loading a Repo. */
export type NativeSessionDomainPort = {
  readonly generation: string;
  assertCurrent(): void;
  read(query: NativeSessionRead, expectedGeneration?: string): Promise<unknown>;
  execute(command: NativeSessionCommand, expectedGeneration: string): Promise<unknown>;
  observe(
    listener: (event: { kind: 'history'; change: SessionDataChange } | { kind: 'control' }) => void,
    onError?: (error: unknown) => void
  ): {
    readonly initial: Promise<readonly SessionDirectoryRow[]>;
    readonly control: Promise<NativeSessionControlState>;
    close(): void;
  };
  close(): void;
};
