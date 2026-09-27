/**
 * Feature-tab demo durations and the demo id union.
 *
 * These live apart from `landing-app-preview.tsx` on purpose. The preview (the
 * product replica and its diff highlighter) sits BELOW the 100dvh hero, so it
 * is loaded lazily from `underwater-experience.tsx`. That module still needs the
 * tab durations at module scope to build `TAB_DURATIONS` — importing them from
 * the preview would pull the whole preview graph back into the landing's
 * critical chunk and silently undo the lazy boundary. Keep this module free of
 * component imports.
 */

/** Scripted scenario for the active feature tab; null = static open session. */
export type LandingDemo = 'worktree' | 'diff' | 'design' | 'mobile' | null;

// Tab fill used to outlive the script by ~half; keep a short hold after the
// reply stream, not empty dead air (was 12s).
export const WORKTREE_DEMO_DURATION_MS = 7_200;
// Feature-tab 2 (live diff review). Boots already on the GitHub clipping session
// with the right panel open — ghost cursor widens + opens the first file slowly
// enough to read, then holds on the live diff.
export const DIFF_DEMO_DURATION_MS = 6_000;
// Feature-tab 3 (design mode / Lody Preview). Back on the `lody` session, the user
// asks for the landing dev server; the reply runs `pnpm dev` + the real
// `lody_report_preview_candidate` MCP tool, the header gains the preview action,
// and the ghost user opens Lody Preview, widens the panel, inspects the hero copy,
// leaves a visual comment, sends it — and the page hot-reloads with the edit.
// Ends with a short hold on the hot-reloaded page so the copy change registers.
export const DESIGN_DEMO_DURATION_MS = 24_000;
// Feature-tab 4 (mobile access). Real mobile UI inside the device frame at the
// same stage height as desktop demos: all-conversations home → new-chat sheet →
// send the jellyfish prompt → the reply streams the image.
export const MOBILE_DEMO_DURATION_MS = 13_000;
