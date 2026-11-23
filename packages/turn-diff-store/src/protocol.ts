import type {
  LatestTurnDiffText,
  ListChangedPathsInput,
  ListTurnFilesInput,
  RecordTurnDiffInput,
  RecordTurnDiffResult,
  SnapshotPathInput,
  SnapshotDescriptorInput,
  SnapshotDescriptor,
  SnapshotBytesInput,
  SnapshotBytes,
  TurnDiffGcResult,
  TurnDiffFileSummary,
  TurnDiffSnapshot,
  TurnDiffSnapshotPair,
  TurnDiffStoreOptions,
  TurnDiffStoreStats,
  TurnSnapshotInput,
} from './types';

type TimedRecordTurnDiffInput = RecordTurnDiffInput & {
  readonly capturedAtMs: number;
  readonly recordedAtMs: number;
};

type TimedInput<Input extends { readonly nowMs?: number }> = Omit<Input, 'nowMs'> & {
  readonly nowMs: number;
};

export interface TurnDiffWorkerCommandMap {
  readonly 'snapshot-descriptor': {
    readonly request: { readonly input: TimedInput<SnapshotDescriptorInput> };
    readonly result: SnapshotDescriptor;
  };
  readonly 'snapshot-bytes': {
    readonly request: { readonly input: TimedInput<SnapshotBytesInput> };
    readonly result: SnapshotBytes;
  };
  readonly init: {
    readonly request: { readonly options: TurnDiffStoreOptions; readonly nowMs: number };
    readonly result: null;
  };
  readonly 'allocate-head-proof': {
    readonly request: object;
    readonly result: number;
  };
  readonly record: {
    readonly request: { readonly input: TimedRecordTurnDiffInput };
    readonly result: RecordTurnDiffResult;
  };
  readonly 'list-changed-paths': {
    readonly request: { readonly input: TimedInput<ListChangedPathsInput> };
    readonly result: readonly string[];
  };
  readonly 'earliest-old': {
    readonly request: { readonly input: TimedInput<SnapshotPathInput> };
    readonly result: TurnDiffSnapshot;
  };
  readonly 'turn-snapshot': {
    readonly request: { readonly input: TimedInput<TurnSnapshotInput> };
    readonly result: TurnDiffSnapshotPair;
  };
  readonly 'latest-text': {
    readonly request: { readonly input: Omit<SnapshotPathInput, 'nowMs'> };
    readonly result: LatestTurnDiffText;
  };
  readonly 'list-turn-files': {
    readonly request: { readonly input: TimedInput<ListTurnFilesInput> };
    readonly result: readonly TurnDiffFileSummary[];
  };
  readonly gc: {
    readonly request: { readonly nowMs: number };
    readonly result: TurnDiffGcResult;
  };
  readonly stats: {
    readonly request: object;
    readonly result: TurnDiffStoreStats;
  };
  readonly close: {
    readonly request: object;
    readonly result: null;
  };
}

export type TurnDiffWorkerKind = keyof TurnDiffWorkerCommandMap;

export type TurnDiffWorkerRequestBody<Kind extends TurnDiffWorkerKind = TurnDiffWorkerKind> =
  Kind extends TurnDiffWorkerKind
    ? { readonly kind: Kind } & TurnDiffWorkerCommandMap[Kind]['request']
    : never;

export type TurnDiffWorkerRequest<Kind extends TurnDiffWorkerKind = TurnDiffWorkerKind> =
  TurnDiffWorkerRequestBody<Kind> & { readonly id: number };

export type TurnDiffWorkerResult<Kind extends TurnDiffWorkerKind> =
  TurnDiffWorkerCommandMap[Kind]['result'];

type TurnDiffWorkerSuccessResponse = {
  [Kind in TurnDiffWorkerKind]: {
    readonly id: number;
    readonly kind: Kind;
    readonly result: TurnDiffWorkerResult<Kind>;
  };
}[TurnDiffWorkerKind];

export type TurnDiffWorkerResponse =
  | TurnDiffWorkerSuccessResponse
  | { readonly id: number; readonly kind: TurnDiffWorkerKind; readonly error: string }
  | { readonly id: 0; readonly backgroundGc: TurnDiffGcResult }
  | { readonly id: 0; readonly backgroundError: string };
