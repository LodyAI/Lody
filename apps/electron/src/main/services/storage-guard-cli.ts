import {
  CLI_STORAGE_WRITE_FAILED_ISSUE_CODE,
  type CliRuntimeState
} from '@lody/shared/electron-ipc'
import type { StorageGuard } from './storage-guard'

/** Runtime issues describe this local CLI, never agents on another machine. */
export function observeCliStorageWriteFailures(
  guard: StorageGuard
): (runtime: CliRuntimeState) => Promise<void> {
  let lastSeenAtMs = Number.NEGATIVE_INFINITY
  return async (runtime) => {
    const issue = runtime.issues.find(
      (candidate) => candidate.code === CLI_STORAGE_WRITE_FAILED_ISSUE_CODE
    )
    if (!issue || issue.lastSeenAtMs <= lastSeenAtMs) return
    lastSeenAtMs = issue.lastSeenAtMs
    await guard.reportWriteFailure('cli')
  }
}
