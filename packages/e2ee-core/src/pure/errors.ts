import { Data } from 'effect';
export type LedgerErrorCode =
  | 'canonical'
  | 'truncated'
  | 'trailing'
  | 'oversize'
  | 'nesting'
  | 'unknown-version'
  | 'unknown-operation'
  | 'bad-signature'
  | 'bad-proof'
  | 'invalid-key'
  | 'unauthorized'
  | 'replay'
  | 'wrong-parent'
  | 'wrong-anchor'
  | 'genesis-mismatch'
  | 'owner-transfer-unconfirmed'
  | 'invalid-operation';

/** Protocol failures preserve the pre-migration wire error code and position. */
export class ValidationError extends Data.TaggedError('ValidationError')<{
  readonly code: LedgerErrorCode;
  readonly position?: number;
}> {}

export class AuthorizationError extends Data.TaggedError('AuthorizationError')<{
  readonly operation: string;
}> {}

export class ContextMismatch extends Data.TaggedError('ContextMismatch')<{
  readonly context: 'genesis' | 'view' | 'signer' | 'epoch' | 'recipient';
}> {}

export class StorageError extends Data.TaggedError('StorageError')<{
  readonly reason: 'missing' | 'exists' | 'corrupt' | 'foreign' | 'busy' | 'io' | 'closed';
  readonly code?: string;
  readonly position?: number;
}> {
  override get message(): string {
    return this.code ?? `storage-${this.reason}`;
  }
}

export class TransportError extends Data.TaggedError('TransportError')<{
  readonly operation: 'read' | 'append' | 'deliver';
  readonly code?: string;
}> {
  override get message(): string {
    return this.code ?? `${this.operation}-failed`;
  }
}

/** A malformed adapter response is not a transient network outage. */
export class StreamProtocolError extends Data.TaggedError('StreamProtocolError')<{
  readonly code: string;
}> {
  override get message(): string {
    return this.code;
  }
}

export class CryptoError extends Data.TaggedError('CryptoError')<{
  readonly operation: 'sign' | 'generate' | 'import' | 'seal' | 'open';
}> {}

export class PendingOperationExists extends Data.TaggedError('PendingOperationExists')<{}> {}

export class EpochRotationError extends Data.TaggedError('EpochRotationError')<{
  readonly reason: 'candidate-missing' | 'candidate-corrupt' | 'candidate-mismatch' | 'key-missing';
}> {
  override get message(): string {
    return this.reason === 'key-missing' ? 'missing-epoch-key' : `epoch-${this.reason}`;
  }
}

/** Host snapshot admission failures keep the pre-migration wire codes. */
export class SnapshotAdmissionError extends Data.TaggedError('SnapshotAdmissionError')<{
  readonly code: string;
}> {
  override get message(): string {
    return this.code;
  }
}

/** Content-frame failures keep the pre-migration wire codes. */
export class ContentError extends Data.TaggedError('ContentError')<{
  readonly code: string;
}> {
  override get message(): string {
    return this.code;
  }
}

/** Recovery-file failures keep the pre-migration wire codes. */
export class RecoveryError extends Data.TaggedError('RecoveryError')<{
  readonly code: string;
}> {
  override get message(): string {
    return this.code;
  }
}

export type ProtocolError = ValidationError | AuthorizationError | ContextMismatch;
export type ClientError =
  | ProtocolError
  | StorageError
  | TransportError
  | StreamProtocolError
  | CryptoError
  | PendingOperationExists;
