export class OrchestrationStorageFailure extends Error {
  readonly _tag = 'OrchestrationStorageFailure';
  readonly kind: 'busy' | 'storage' | 'invariant';
  readonly code?: string;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.code =
      cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
        ? cause.code
        : undefined;
    this.kind =
      this.code === 'SQLITE_BUSY' || this.code === 'SQLITE_BUSY_SNAPSHOT'
        ? 'busy'
        : this.code?.startsWith('SQLITE_CONSTRAINT') || this.code === 'OPERATION_ID_REUSED'
          ? 'invariant'
          : 'storage';
  }
}
