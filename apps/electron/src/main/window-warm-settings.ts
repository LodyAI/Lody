/**
 * Runtime-only developer switch for the auxiliary warm renderer. It is
 * intentionally off by default: enabling the Devbar does not silently add a
 * hidden Chromium renderer to ordinary desktop sessions.
 */
let enabled = false

export function isWindowWarmupEnvironmentAllowed(): boolean {
  return process.env['LODY_E2E'] !== '1' && process.env['LODY_DISABLE_WINDOW_WARMUP'] !== '1'
}

export function isWindowWarmupEnabled(): boolean {
  return enabled && isWindowWarmupEnvironmentAllowed()
}

export function setWindowWarmupSetting(next: boolean): void {
  enabled = next
}
