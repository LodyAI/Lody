import { type SessionStatus } from '@lody/shared';
import type { SessionActivePresencePhase } from './loro/session-active-presence';

/**
 * Decisions for async, post-hoc session status writes that run outside the
 * visible active scope (permission resolution restore). Those callbacks can
 * fire after the turn ended and its active presence was cleared; without
 * active presence a working-status write is a lie — the presence entry cannot
 * be kept alive while meta status stays stuck non-idle.
 *
 * Rule: never write a working status without active presence. Stuck statuses
 * left behind by crashes are the dispatch watcher's stale-status recovery job,
 * not these callbacks'.
 *
 * Codex image-generation activity is presence-only. Image begin/end must not
 * write durable SessionMeta.status: that path awaits getDocMeta/upsert and can
 * land after prompt-end has already published `finalizing` and idle.
 */

/**
 * Presence phase the Codex image-generation activity sync may apply.
 * Only thinking ↔ image_generation. Finalizing, permission, initializing, and
 * missing presence stay owned by the turn scope.
 */
export const resolveImageGenerationPresencePhase = (input: {
  hasActiveImageGeneration: boolean;
  current: SessionStatus | null | undefined;
}): Extract<SessionActivePresencePhase, 'image_generation' | 'thinking'> | null => {
  if (input.current?.type !== 'running' || input.current.phase === 'finalizing') {
    return null;
  }
  if (input.hasActiveImageGeneration) {
    return 'image_generation';
  }
  if (input.current.activity === 'image_generation') {
    return 'thinking';
  }
  return null;
};

/**
 * Whether permission resolution should restore `running` status.
 * `status: 'unknown'` means the doc could not report a status (test doubles);
 * historically that defaulted to restoring, but only active presence makes
 * the restored status sustainable.
 */
export const shouldRestoreRunningAfterPermission = (input: {
  hasActivePresence: boolean;
  status: SessionStatus | undefined | 'unknown';
}): boolean => {
  if (!input.hasActivePresence) {
    return false;
  }
  if (input.status === 'unknown') {
    return true;
  }
  return input.status?.type === 'requestPermission' || input.status?.type === 'running';
};
