import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getLodyDataDir } from './installation-profile';

function preferencePath(): string {
  return join(getLodyDataDir('cloud'), 'usage-sharing');
}

// The enabled revision also fences batches buffered before a disable/enable cycle.
function storedRevision(): string | null {
  if (process.env.LODY_DISABLE_USAGE_SHARING === '1') return null;
  try {
    const choice = readFileSync(preferencePath(), 'utf8');
    return /^on:[0-9a-f-]{36}$/.test(choice) ? choice : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'default' : null;
  }
}

export function desktopUsageChoice(): boolean | null {
  const revision = storedRevision();
  return revision === 'default' ? null : revision !== null;
}

export function usageSharingRevision(
  requireChoice = process.env.LODY_REQUIRE_USAGE_SHARING_CHOICE === '1' ||
    process.env.LODY_ELECTRON_BOOTSTRAP === '1' ||
    !!process.versions.electron
): string | null {
  const revision = storedRevision();
  return requireChoice && revision === 'default' ? null : revision;
}

export function writeUsageSharing(enabled: boolean): void {
  if (enabled && desktopUsageChoice() === true) return;
  mkdirSync(getLodyDataDir('cloud'), { recursive: true });
  const path = preferencePath();
  const revision = randomUUID();
  const temporary = path + '.' + revision;
  writeFileSync(temporary, enabled ? 'on:' + revision : 'off', { mode: 0o600 });
  renameSync(temporary, path);
}
