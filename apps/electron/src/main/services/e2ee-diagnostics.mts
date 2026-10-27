/** Main-process-only diagnostic slot. Never attach raw causes to IPC Errors or
 * telemetry. Retain one original failure while journals retain cleanup ownership. */
let latest: { source: string; cause: unknown } | undefined
export function rememberDesktopE2eeFailure(source: string, cause: unknown): void {
  latest = { source, cause }
}
/** Native diagnostics and behavioral tests only; not part of the IPC registry. */
export function desktopE2eeFailure(): typeof latest {
  return latest
}
