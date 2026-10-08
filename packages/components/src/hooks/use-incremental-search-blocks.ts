import { useEffect, useRef, useState } from 'react';
import type { SessionHistory } from '@lody/shared';
import { subscribeOnFrame, type ConversationView } from '@/lib/conversation-view';
import { extractSearchBlocksForMessage, type SessionSearchBlock } from '@/lib/session-chat-search';

const EMPTY_BLOCKS: SessionSearchBlock[] = [];

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
  const cacheRef = useRef(
    new WeakMap<SessionHistory, { index: number; blocks: SessionSearchBlock[] }>()
  );

  useEffect(() => {
    if (!isSearchOpen || !view) {
      setBlocks(EMPTY_BLOCKS);
      return undefined;
    }
    let cancelled = false;
    let range: ReturnType<ConversationView['acquireRange']> | undefined;

    const rebuild = () => {
      if (cancelled) return;
      const cache = cacheRef.current;
      const next: SessionSearchBlock[] = [];
      for (let i = 0; i < view.turnCount; i += 1) {
        const turn = view.turn(i);
        if (!turn) continue;
        let cached = cache.get(turn);
        if (!cached || cached.index !== i) {
          cached = { index: i, blocks: extractSearchBlocksForMessage(turn, i) };
          cache.set(turn, cached);
        }
        for (const block of cached.blocks) next.push(block);
      }
      setBlocks(next);
    };
    // Hydration and streaming both rebuild at most once per frame.
    const unsubscribe = subscribeOnFrame((listener) => view.subscribe(listener), rebuild);
    const acquire = () => {
      // Pin the new set before releasing the old one, keeping unchanged turns cached.
      const next = view.acquireRange(0, view.turnCount);
      range?.release();
      range = next;
      void next.ready.then(
        () => {
          if (range === next) rebuild();
        },
        (error) => console.error('Failed to load conversation search', error)
      );
    };
    const unsubscribeStructure = view.subscribe((change) => {
      if (change.kind === 'structure') acquire();
    });
    acquire();

    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeStructure();
      range?.release();
    };
  }, [isSearchOpen, view]);

  return isSearchOpen ? blocks : EMPTY_BLOCKS;
}
