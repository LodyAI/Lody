export { createRemoteRoostSessionDataFactory } from './packages/components/src/lib/roost-session-bridge';
export { readSessionHistoryMetadata } from './session-data';
export { buildPendingUserHistoryEntry } from './packages/shared/src/session-input';
export { HistoryEntryWriteSchema, parseHistoryWrite } from './packages/shared/src/history-write-schema';
export { resolveNewSessionHistoryBackend, machineSupportsSessionHistoryProtocol, machineSupportsSessionHistoryIncremental, machineSupportsSessionHistoryWatch, machineSupportsSessionHistoryPatches, machineSupportsSessionHistoryInspection, machineSupportsSessionInputAcceptance, machineSupportsSessionInputDispatch } from './packages/shared/src/machine-protocol-capabilities';
export { createAcceptedSessionInputs, SessionInputNotSentError } from './packages/components/src/lib/session-accepted-inputs';
export { createSessionInputStorage } from './packages/components/src/lib/session-input-storage';

export { createWorkspaceAcceptedInputs } from './packages/components/src/lib/workspace-accepted-inputs';
export { createSessionOperationScope } from './packages/components/src/lib/session-send-resources';
