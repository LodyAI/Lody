import type { FileDiff, SessionHistory } from '@lody/shared';
import type { ConversationView } from './conversation-view';

/**
 * Index- and tail-only readers over a `ConversationView`. Each one answers a
 * question the app used to ask of the full `history` array without hydrating
 * a single turn it does not have to.
 */

/**
 * The open assistant turn, if the newest assistant turn is still running:
 * the same rule as `resolveActiveAssistantTurnId` in `@lody/shared`, read from
 * index rows (`role`, `finished`, `endedAt` are index fields) from the tail.
 */
export function resolveActiveAssistantTurnIdFromView(view: ConversationView): string | undefined {
  for (let i = view.turnCount - 1; i >= 0; i -= 1) {
    const row = view.index(i);
    if (!row || row.role !== 'assistant') continue;
    if (row.finished === true || typeof row.endedAt === 'number') return undefined;
    return row.id;
  }
  return undefined;
}

/** The hydrated turn with `id`, or the index it lives at when not hydrated. */
export function readTurnById(
  view: ConversationView,
  turnId: string
): { index: number; turn: SessionHistory | undefined } {
  const index = view.indexOf(turnId);
  return { index, turn: index >= 0 ? view.turn(index) : undefined };
}

/** Hydrate one turn by id and return it. */
export async function ensureTurnById(
  view: ConversationView,
  turnId: string
): Promise<SessionHistory | undefined> {
  const index = view.indexOf(turnId);
  if (index < 0) return undefined;
  await view.ensureRange(index, index + 1);
  return view.turn(index);
}

/**
 * Which turn carries the permission request `requestId`, searching the
 * hydrated tail first. Returns -1 when no hydrated turn carries it; the writer
 * then scans the doc itself, which needs no hydration.
 */
export function findPermissionRequestTurnIndex(view: ConversationView, requestId: string): number {
  for (let i = view.turnCount - 1; i >= 0; i -= 1) {
    if (!view.isHydrated(i)) continue;
    const turn = view.turn(i);
    if (!turn || !Array.isArray(turn.items)) continue;
    for (const item of turn.items as unknown[]) {
      const request = (item as { permissionRequest?: { requestId?: string } } | null)
        ?.permissionRequest;
      if (request?.requestId === requestId) return i;
    }
  }
  return -1;
}

export type SystemNoticeSearch =
  | { found: true }
  | { found: false; unhydratedSystemTurnIndex: number | null };

/**
 * Whether any turn carries the `system_notice` named `name`. Only `system`
 * turns can, so non-system turns are skipped from the index alone; a system
 * turn that is not hydrated is reported so the caller can hydrate it and ask
 * again, instead of hydrating the whole transcript.
 */
export function findSystemNotice(view: ConversationView, name: string): SystemNoticeSearch {
  let unhydrated: number | null = null;
  for (let i = view.turnCount - 1; i >= 0; i -= 1) {
    const row = view.index(i);
    if (!row || row.role !== 'system') continue;
    const turn = view.turn(i);
    if (!turn) {
      unhydrated ??= i;
      continue;
    }
    const items = Array.isArray(turn.items) ? (turn.items as unknown[]) : [];
    for (const item of items) {
      const notice = item as { type?: string; name?: string } | null;
      if (notice?.type === 'system_notice' && notice.name === name) return { found: true };
    }
  }
  return { found: false, unhydratedSystemTurnIndex: unhydrated };
}

export type TurnDiffInput = { id: string; role: SessionHistory['role']; fileDiff: FileDiff[] };

/**
 * One light `{ id, role, fileDiff }` per turn, built from index rows and the
 * per-turn `fileDiff` cache, so the diff summary sees every turn's edits
 * without hydrating any message items.
 */
export function readDiffInputsFromView(view: ConversationView): TurnDiffInput[] {
  const inputs: TurnDiffInput[] = [];
  for (let i = 0; i < view.turnCount; i += 1) {
    const row = view.index(i);
    if (!row?.id) continue;
    inputs.push({ id: row.id, role: row.role, fileDiff: view.fileDiff(i) ?? [] });
  }
  return inputs;
}
