export { startLabBackend, type LabBackend } from './backend';
export { HonestClient, type HonestClientOptions } from './actors';
export {
  advanceTime,
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
  replayAttackActions,
  type AttackAction,
  type AttackClaim,
  type AttackLab,
  type PublicReport,
  type PublicView,
} from './attack-lab';
export { LabRuntime, type ProtocolFrame } from './runtime';
export {
  prefixedEntropy,
  recordingEntropy,
  replayEntropy,
  type EntropyFill,
  type PublicScenarioSeed,
} from './entropy';
