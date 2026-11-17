export * from './packages/shared/src/message-schemas';
export { HistoryEntryWriteSchema, parseHistoryWrite } from './packages/shared/src/history-write-schema';
export { getServerNow } from './packages/shared/src/time-sync';
export { isLoroRepoDocDeleted } from './packages/shared/src/repo-doc-meta';
export { isSessionHistoryStatusAwaitingStart, isSessionHistoryPendingForDispatch } from './packages/shared/src/schema';
export { queuedInputEvidence } from './packages/shared/src/session-input';
export const SESSION_DOC_PREFIX = 'session-';
export const getSessionRoomId = (sessionId: string) => `${SESSION_DOC_PREFIX}${sessionId}`;

export const getMachineRoomId = (id: string) => `machine-${id}`;
export { machineSupportsSessionInputAcceptance, machineSupportsSessionInputDispatch } from './packages/shared/src/machine-protocol-capabilities';
export { normalizeSessionInputBlocks } from './packages/shared/src/session-input';
