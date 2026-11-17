import { Data } from 'effect';

export class MachineSharingError extends Data.TaggedError('MachineSharingError')<{
  readonly code:
    | 'machine_not_shared'
    | 'machine_not_owned'
    | 'sharing_conflict'
    | 'sharing_unavailable'
    | 'sharing_storage'
    | 'sharing_invalid'
    | 'closed';
}> {}
