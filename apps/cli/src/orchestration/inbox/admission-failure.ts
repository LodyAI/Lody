import { Data } from 'effect';

/** Admission alone does not establish that an execution has stale resources. */
export class InboxExecutionRejected extends Data.TaggedError('InboxExecutionRejected')<{}> {
  override get message(): string {
    return 'INBOX_EXECUTION_REJECTED: this input is not eligible for execution';
  }
}
