import type { TerminalNotification } from '@lody/shared/notifications';
import type {
  SessionForkOperation,
  SessionPreviewDocState,
  SessionExternalHistoryCursorDocState,
  MessageQueueItem,
  MessageQueueItemInput,
  SessionDocMeta,
  SessionMeta,
  SessionId,
  SessionAcpRuntimeConfigPatch,
  SessionImagePayload,
} from '@lody/shared';
import type { SessionBackend } from './native-session-contract';

export type NativeSessionInitialState = Partial<
  Omit<SessionDocMeta, 'history' | 'session' | 'forkOperation'>
> & {
  readonly forkOperation?: SessionForkOperation;
  readonly session?: Partial<SessionDocMeta['session']>;
  readonly history?: readonly import('@lody/shared').SessionHistoryInput[];
};
/** Workspace Meta retains its own existing room owner. These private Node
 * callbacks never grant access to an old Session body or expose a Repo to UI. */
export type NativeSessionMetadataPort = {
  read(): Promise<SessionMeta | undefined>;
  patch(fields: Partial<SessionMeta>): Promise<void>;
  /** Pure plan re-evaluated at the authoritative Meta room CAS head. */
  update?(transform: (current: SessionMeta) => Partial<SessionMeta> | undefined): Promise<void>;
  flush(): Promise<void>;
};
export type NativeSessionControlPort = {
  readDirectorySnapshot(): readonly import('@lody/shared/session-data').SessionDirectoryRow[];
  frontiers(): readonly { peer: `${number}`; counter: number }[];
  causalVersion(): string;
  hasCausalFrontiers(frontiers: readonly { peer: string; counter: number }[]): boolean;
  read(): Promise<Omit<SessionDocMeta, 'history'>>;
  observe(listener: () => void): () => void;
  getForkOperation(): SessionForkOperation | undefined;
  setForkOperation(value: SessionForkOperation | undefined): Promise<void>;
  recordHumanInputReceipt(inputId: string, userId: string): Promise<void>;
  setCancelRequest(value: { readonly id: string; readonly turnId: string }): Promise<void>;
  setNotification(value: TerminalNotification): Promise<void>;
  setPreview(value: SessionPreviewDocState): Promise<void>;
  setExternalHistoryCursor(value: SessionExternalHistoryCursorDocState): Promise<void>;
  applyAcpRuntimeConfigPatch(
    basedOnUserTurnId: string,
    patch: SessionAcpRuntimeConfigPatch
  ): Promise<boolean>;
  getMessageQueue(): Promise<MessageQueueItem[]>;
  peekReadyMessageQueue(): Promise<MessageQueueItem | null>;
  pushMessageQueue(item: MessageQueueItemInput): Promise<void>;
  updateMessageQueueItem(cid: string, patch: Partial<MessageQueueItem>): Promise<void>;
  removeMessageQueueItem(cid: string): Promise<void>;
  reorderMessageQueue(cids: readonly string[]): Promise<void>;
  promoteLocalImageReferences(image: SessionImagePayload): Promise<void>;
};
export type NativeSessionDocumentOwner = {
  readonly generation: string;
  assertCurrent(): void;
  readonly backend: SessionBackend;
  readonly control: NativeSessionControlPort;
  initialize(
    initial: NativeSessionInitialState | undefined,
    options: { skipAutoRead: boolean; remoteSync: boolean }
  ): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
};
/** Undefined is permitted only for a positively legacy route. A selected/frozen
 * native room that is missing, unauthorized or incompatible must reject. The
 * manager injects this before SessionDocument opens any legacy body. */
export type NativeSessionDocumentFactory = ((
  sessionId: SessionId,
  metadata: NativeSessionMetadataPort,
  options: { readonly historyBackend: 'loro' | 'roost' }
) => Promise<NativeSessionDocumentOwner | undefined>) & {
  /** Includes native/frozen/blocked routes. Throws on unknown ownership. */
  readonly binding: {
    readonly accountId: string;
    readonly workspaceId: import('@lody/shared').WorkspaceId;
  };
  ownsRoom(roomId: string): boolean | Promise<boolean>;
  /** Checks the same persistent per-room journal at the actual old write boundary. */
  assertLegacyRoom?(roomId:string):void;
  /** Retires every facade for this room; never closes sibling rooms/the host. */
  retireRoom?(sessionId:SessionId):Promise<void>;
  close(): Promise<void>;
};
