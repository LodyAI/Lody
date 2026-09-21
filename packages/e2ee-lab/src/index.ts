export { startLabBackend, type LabBackend } from './backend';
export { HonestClient, type HonestClientOptions } from './actors';
export {
  advanceTime,
  canPermitEvent,
  completeEvent,
  emptyScheduler,
  isRunnable,
  permitEvent,
  recordEvent,
  requestEvent,
  type LabEvent,
  type SchedulerCommand,
  type SchedulerState,
} from './scheduler';
export { exploreSubmitInterleavings } from './model';
export { publicTrace, type PublicTrace } from './trace';
export {
  eventSignature,
  firstDivergence,
  firstReplayDivergence,
  normalizeFrameHex,
  type Divergence,
  type ReplayMaterial,
} from './replay';
export { normalizeMultipartBody } from './multipart';
export { ScheduleDriver, leftoverRequested } from './driver';
export { eventIdentity, identityKey, type EventIdentity, type ScheduleChoice } from './schedule';
export {
  fingerprintOf,
  fingerprintsEqual,
  isSecurityFingerprint,
  type FailureFingerprint,
} from './fingerprint';
export {
  refMayAdmit,
  refMayRecover,
  refMaySendEpoch,
  refMayWriteDocument,
  refCursorAllowed,
  refRetryPreservesCommit,
  refSnapshotAdmissible,
  type RefState,
} from './reference-model';
export {
  applyKnownDefect,
  injectCursorBeforeDocument,
  injectSkipVerify,
  injectWrongContextJournal,
  measureClient,
  type KnownDefect,
} from './defects';
export { minimizeCounterexample, type MinimizeResult } from './minimize';
export {
  createCollabPack,
  createDefectPack,
  loadReproPack,
  replayReproPack,
  writeReproPack,
  type ReproPack,
} from './repro-pack';
export {
  captureImplementationIdentity,
  REPRO_FORMAT,
  type ImplementationIdentity,
} from './identity';

export {
  composeDurability,
  composeIntegrity,
  defectiveAcceptInvalid,
  honestBaselineReport,
  judgeClaim,
  judgeCursor,
  judgeFork,
  judgeImport,
  judgeLeak,
  judgeUnauthorized,
  judgeUnauthorizedContent,
  type JudgeReport,
  type JudgeVerdict,
  type ScenarioRecord,
} from './judge';
export { appendControlRecord, maliciousAppendCas, mutateSqliteBytes } from './attacks';
export {
  createAttackLab,
  harnessReplayActions,
  harnessReplayMaterial,
  inspectClient,
  replayAttackActions,
  type AttackAction,
  type AttackClaim,
  type AttackLab,
  type ClientDigest,
  type HonestInspect,
  type PublicReport,
  type PublicView,
  type ReplayMaterial as AttackReplayMaterial,
  type ReplayOutcome,
} from './attack-lab';
export {
  LabClock,
  LabFs,
  LabHttp,
  LiveLabLayer,
  makeTestClock,
  MemoryLabFs,
  TestLabClock,
  TestLabHttp,
  type LabServices,
} from './services';
export { LabRuntime, type ProtocolFrame } from './runtime';
export {
  isReplayEntropy,
  prefixedEntropy,
  recordingEntropy,
  replayEntropy,
  type EntropyFill,
  type PublicScenarioSeed,
  type ReplayEntropy,
} from './entropy';
