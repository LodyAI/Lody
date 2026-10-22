import { Data } from 'effect';
import type { BlockedInboxExecution } from './recovery';

/** Admission alone does not establish that an execution has stale resources. */
export class InboxExecutionRejected extends Data.TaggedError('InboxExecutionRejected')<{}> {
  override get message(): string {
    return 'INBOX_EXECUTION_REJECTED: this input is not eligible for execution';
  }
}

export class InboxExecutionBlocked extends Data.TaggedError('InboxExecutionBlocked')<{
  blocked: readonly BlockedInboxExecution[];
}> {
  override get message(): string {
    return 'INBOX_EXECUTION_BLOCKED: release of an earlier execution is unconfirmed';
  }
}

/** Single-quoted literals: PowerShell on Windows, POSIX shells elsewhere. */
export const quoteInboxRecoveryArgument = (value: string, platform: NodeJS.Platform): string =>
  `'${platform === 'win32' ? value.replace(/['\u2018-\u201b]/gu, '$&$&') : value.replaceAll("'", "'\\''")}'`;

export const inboxRecoveryInspectionCommand = (
  target: { machineId: string; workspaceId: string; sessionId: string },
  platform: NodeJS.Platform
): string => {
  const quote = (value: string) => quoteInboxRecoveryArgument(value, platform);
  // End option parsing before the positional ID, including IDs beginning with '-'.
  return `lody session recover-inbox --machine ${quote(target.machineId)} --workspace ${quote(target.workspaceId)} -- ${quote(target.sessionId)}`;
};

export const blockedInboxRecoveryMessage = (
  error: InboxExecutionBlocked,
  target: { machineId: string; workspaceId: string; sessionId: string },
  platform: NodeJS.Platform
): string =>
  [
    'Inbox is blocked because release of earlier execution resources is unconfirmed. This does not prove the resources have stopped.',
    `Machine: ${JSON.stringify(target.machineId)}; workspace: ${JSON.stringify(target.workspaceId)}; session: ${JSON.stringify(target.sessionId)}.`,
    ...error.blocked.map(
      (record) =>
        `Blocked execution: ${record.executionId === null ? '(missing active execution ID)' : JSON.stringify(record.executionId)}; reason: ${record.reason}.`
    ),
    'Quit Lody Desktop and stop the Lody daemon on that machine, then inspect from a terminal outside an Agent session.',
    `${platform === 'win32' ? 'PowerShell' : 'POSIX shell'} (inspection only):`,
    inboxRecoveryInspectionCommand(target, platform),
    'Inspection does not recover or replay input. Recovery requires separately verifying all old resources, including unrecorded ones, are released. Unknown input is never replayed; send a new message after recovery.',
  ].join('\n');
