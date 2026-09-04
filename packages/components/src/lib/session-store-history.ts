import { resolveActiveAssistantTurnId, type SessionHistory } from '@lody/shared';
import type { SessionDocStore } from '@/atoms/runtime';
import { ensureTurnById, resolveActiveAssistantTurnIdFromView } from './conversation-view';

/**
 * History reads against a `SessionDocStore` that stay O(1) or O(one turn)
 * when the store carries a `ConversationView`, and fall back to the full
 * `getState().history` array on the rollback path. Hooks that used to
 * `getState().history.find(...)` go through here so the flag decides the
 * cost, not the call site.
 */

export async function readSessionHistoryEntry(
  store: SessionDocStore,
  entryId: string
): Promise<SessionHistory | undefined> {
  const view = store.conversationView;
  if (view) return await ensureTurnById(view, entryId);
  return (store.getState().history as SessionHistory[]).find((entry) => entry.id === entryId);
}

/** The user turn with `userTurnId`, or `undefined` when absent or not a user turn. */
export async function readSessionUserTurn(
  store: SessionDocStore,
  userTurnId: string
): Promise<SessionHistory | undefined> {
  const entry = await readSessionHistoryEntry(store, userTurnId);
  return entry?.role === 'user' ? entry : undefined;
}

export function readActiveAssistantTurnId(store: SessionDocStore): string | undefined {
  const view = store.conversationView;
  if (view) return resolveActiveAssistantTurnIdFromView(view);
  return resolveActiveAssistantTurnId(store.getState().history);
}

export function readSessionHistoryLength(store: SessionDocStore): number {
  const view = store.conversationView;
  if (view) return view.turnCount;
  return store.getState().history?.length ?? 0;
}
