import { useEffect, useRef, useState } from 'react';
import type { SessionHistory } from '@lody/shared';
import { subscribeOnFrame, type ConversationView } from '@/lib/conversation-view';
import { extractSearchBlocksForMessage, type SessionSearchBlock } from '@/lib/session-chat-search';

const EMPTY_BLOCKS: SessionSearchBlock[] = [];

/** Turns hydrated per step while filling the search index. */
const HYDRATE_CHUNK = 48;

/**
 * Builds the in-conversation search index lazily, only while search is open.
 *
 * Search is the one reader that genuinely needs every turn's prose, so while
 * it is open the whole conversation is hydrated — TEMPORARILY: the range is
 * pinned for the life of the open search and released when it closes, after
 * which the view's LRU evicts the turns again. Blocks are cached per turn
 * object, so streaming re-extracts only the turn that changed, and the index
 * is refreshed at most once per frame.
 */
export function useIncrementalSearchBlocks(
  view: ConversationView | null | undefined,
  isSearchOpen: boolean
): SessionSearchBlock[] {
  const [blocks, setBlocks] = useState<SessionSearchBlock[]>(EMPTY_BLOCKS);
  const cacheRef = useRef(new WeakMap<SessionHistory, SessionSearchBlock[]>());

  useEffect(() => {
    if (!isSearchOpen || !view) {
      setBlocks(EMPTY_BLOCKS);
      return undefined;
    }
    let cancelled = false;
    const pinned: [number, number][] = [];

    const rebuild = () => {
      if (cancelled) return;
      const cache = cacheRef.current;
      const next: SessionSearchBlock[] = [];
      for (let i = 0; i < view.turnCount; i += 1) {
        const turn = view.turn(i);
        if (!turn) continue;
        let turnBlocks = cache.get(turn);
        if (!turnBlocks) {
          turnBlocks = extractSearchBlocksForMessage(turn, i);
          cache.set(turn, turnBlocks);
        }
        for (const block of turnBlocks) next.push(block);
      }
      setBlocks(next);
    };
    // Streaming changes coalesce to one rebuild per frame; the hydration loop
    // below already yields between chunks, so it rebuilds directly.
    const unsubscribe = subscribeOnFrame((listener) => view.subscribe(listener), rebuild);
    void (async () => {
      for (let from = 0; from < view.turnCount; from += HYDRATE_CHUNK) {
        if (cancelled) break;
        const to = Math.min(view.turnCount, from + HYDRATE_CHUNK);
        pinned.push([from, to]);
        await view.ensureRange(from, to);
        rebuild();
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
      for (const [from, to] of pinned) view.release(from, to);
    };
  }, [isSearchOpen, view]);

  return isSearchOpen ? blocks : EMPTY_BLOCKS;
}
