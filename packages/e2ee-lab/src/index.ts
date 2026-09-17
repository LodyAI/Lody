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
  type Divergence,
  type ReplayMaterial,
} from './replay';
export {
  defectiveAcceptInvalid,
  honestBaselineReport,
  judgeCursor,
  judgeFork,
  judgeImport,
  judgeLeak,
  judgeUnauthorized,
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
export { LabRuntime, type ProtocolFrame } from './runtime';
export {
  prefixedEntropy,
  recordingEntropy,
  replayEntropy,
  type EntropyFill,
  type PublicScenarioSeed,
} from './entropy';
