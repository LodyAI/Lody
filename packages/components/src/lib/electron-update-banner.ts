import type { ElectronUpdaterState } from '@lody/shared';
import { normalizeSupportedLanguage } from '@lody/shared/language';

/**
 * Sidebar update banner model. `downloading` and `downloaded` are the only
 * phases the banner speaks for: earlier phases have nothing actionable, and
 * later ones are terminal for this app instance.
 */
export type UpdateBannerState = {
  stage: 'downloading' | 'downloaded';
  version: string;
  /** Rounded 0-100 download progress; null when the feed reports no percent. */
  percent: number | null;
};

function readTargetVersion(state: ElectronUpdaterState): string | null {
  const downloadedVersion = state.downloadedVersion?.trim();
  if (state.phase === 'downloaded' && downloadedVersion) return downloadedVersion;
  const availableVersion = state.availableVersion?.trim();
  if (availableVersion) return availableVersion;
  return downloadedVersion || null;
}

function readPercent(state: ElectronUpdaterState): number | null {
  const percent = state.percent;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  return Math.round(Math.min(100, Math.max(0, percent)));
}

/**
 * Resolve the banner to show for an updater snapshot, or null when the update
 * is not far enough along (or too far) to be worth interrupting the sidebar.
 */
export function readUpdateBannerState(
  state: ElectronUpdaterState | null
): UpdateBannerState | null {
  if (!state) return null;
  if (state.phase !== 'downloading' && state.phase !== 'downloaded') return null;

  const version = readTargetVersion(state);
  if (!version) return null;

  return {
    stage: state.phase,
    version,
    percent: state.phase === 'downloading' ? readPercent(state) : null,
  };
}

/**
 * Pick the changelog text for the language the UI is currently rendering in.
 * Falls back to English localized notes, then to the publisher-provided
 * `releaseNotes`, so a build without localized notes still shows something.
 */
export function pickLocalizedReleaseNotes(
  state: ElectronUpdaterState | null,
  language: string | undefined
): string | null {
  if (!state) return null;

  const byLocale = state.releaseNotesByLocale;
  const normalized = normalizeSupportedLanguage(language) ?? 'en';
  const preferred = byLocale?.[normalized];

  for (const candidate of [preferred, byLocale?.en, state.releaseNotes]) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }

  return null;
}
