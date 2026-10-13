import { Data } from 'effect';
export type ValidationErrorCode =
  | 'canonical'
  | 'truncated'
  | 'trailing'
  | 'oversize'
  | 'nesting'
  | 'bad-signature'
  | 'invalid-key'
  | 'invalid-operation';

/** Protocol failures preserve the pre-migration wire error code and position. */
export class ValidationError extends Data.TaggedError('ValidationError')<{
  readonly code: ValidationErrorCode;
  readonly position?: number;
}> {}

export class ContentError extends Data.TaggedError('ContentError')<{
  readonly code: string;
}> {}
