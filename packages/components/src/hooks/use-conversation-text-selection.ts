import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import type { VirtualizerHandle } from 'virtua';
import type { ConversationRange, ConversationView } from '@/lib/conversation-view';
import { useLatestRef } from './use-latest-ref';

export const CONVERSATION_OVERSCAN = 800;
export const NativeTextSelectionHoldContext = createContext(false);

/** Hold only presentation inputs; callers must keep actions and session state live. */
export function useSelectionStableValue<T>(value: T): T {
  const held = useContext(NativeTextSelectionHoldContext);
  const snapshot = useRef(value);
  if (!held) snapshot.current = value;
  return snapshot.current;
}

export type SelectableConversationRow = {
  key: string;
  turnId: string;
  turnIndex: number;
  ready: boolean;
};

type RetainedTurn<T> = { snapshot: T; lease?: ConversationRange; failed?: boolean };

/** Owns native text selection, independently of the image-sharing checkbox selection. */
export function useConversationTextSelection<T>({
  sessionId,
  view,
  viewport,
  virtualizer,
  rows,
  leadingRowCount,
  captureTurn,
  onCopyUnavailable,
  onChange,
  onRelease,
  activeRef,
}: {
  sessionId: string;
  view?: ConversationView | null;
  viewport: HTMLElement | null;
  virtualizer: RefObject<VirtualizerHandle | null>;
  rows: readonly SelectableConversationRow[];
  leadingRowCount: number;
  captureTurn: (id: string) => T;
  onCopyUnavailable: () => void;
  onChange: () => void;
  onRelease: () => void;
  activeRef: MutableRefObject<boolean>;
}) {
  const [version, setVersion] = useState(0);
  const retained = useRef(new Map<string, RetainedTurn<T>>());
  const current = useLatestRef({
    view,
    rows,
    leadingRowCount,
    captureTurn,
    onCopyUnavailable,
    onChange,
    onRelease,
  });

  const reconcile = useRef<(() => void) | undefined>(undefined);
  const source = view?.factSource ?? view;
  useLayoutEffect(() => {
    if (!viewport) return undefined;
    const doc = viewport.ownerDocument;
    let disposed = false;
    let pointerDown = false;
    let generation = 0;

    const publish = () => {
      if (!disposed) {
        setVersion((value) => value + 1);
        current.current.onChange();
      }
    };
    const release = () => {
      generation++;
      const old = retained.current;
      retained.current = new Map();
      current.current.onRelease();
      activeRef.current = false;
      for (const turn of old.values()) turn.lease?.release();
      if (old.size) publish();
    };
    const selectionRange = (): Range | null => {
      const selection = doc.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
      const range = selection.getRangeAt(0);
      return range.intersectsNode(viewport) ? range : null;
    };
    const rowIndex = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement;
      const row = element?.closest<HTMLElement>('[data-conversation-row-key]');
      if (!row || !viewport.contains(row)) return -1;
      return current.current.rows.findIndex((item) => item.key === row.dataset.conversationRowKey);
    };
    const rangeRows = (range: Range): [number, number] | null => {
      let start = rowIndex(range.startContainer);
      let end = rowIndex(range.endContainer);
      if (start < 0 || end < 0) {
        // Select All and a range crossing pane boundaries may end on a container.
        const intersected = [...viewport.querySelectorAll('[data-conversation-row-key]')]
          .filter((element) => range.intersectsNode(element))
          .map((element) => rowIndex(element))
          .filter((index) => index >= 0);
        if (!intersected.length) return null;
        if (start < 0) start = Math.min(...intersected);
        if (end < 0) end = Math.max(...intersected);
      }
      return [Math.min(start, end), Math.max(start, end)];
    };
    const retainIds = (ids: Iterable<string>) => {
      let changed = false;
      const epoch = generation;
      for (const id of ids) {
        const previous = retained.current.get(id);
        const history = source;
        const index = history?.indexOf(id) ?? -1;
        if (previous && !previous.failed && (previous.lease || index < 0)) continue;
        // acquireRange pins synchronously, before a viewport lease can evict this body.
        const lease = index >= 0 ? history?.acquireRange(index, index + 1) : undefined;
        const held = {
          snapshot: previous?.snapshot ?? current.current.captureTurn(id),
          lease,
          failed: false,
        };
        retained.current.set(id, held);
        previous?.lease?.release();
        changed = true;
        if (lease) {
          void lease.ready.then(
            () => {
              if (!disposed && epoch === generation) publish();
            },
            () => {
              if (!disposed && epoch === generation) {
                held.failed = true;
                publish();
              }
            }
          );
        }
      }
      if (changed) {
        activeRef.current = true;
        publish();
      }
    };
    const retain = (from: number, to: number) => {
      retainIds(
        new Set(current.current.rows.slice(Math.max(0, from), to + 1).map((row) => row.turnId))
      );
    };
    const retainSelection = (range: Range) => {
      const bounds = rangeRows(range);
      if (bounds) {
        retain(...bounds);
      }
    };
    const retainFrontier = () => {
      const handle = virtualizer.current;
      if (!handle || !retained.current.size) return;
      const list = current.current.rows;
      const held = list.flatMap((row, index) => (retained.current.has(row.turnId) ? [index] : []));
      if (!held.length) return;
      // Read the DOM offset: Virtua's scroll listener has not run yet in capture.
      const first =
        handle.findItemIndex(Math.max(0, viewport.scrollTop - CONVERSATION_OVERSCAN)) -
        current.current.leadingRowCount;
      const last =
        handle.findItemIndex(viewport.scrollTop + viewport.clientHeight + CONVERSATION_OVERSCAN) -
        current.current.leadingRowCount;
      retain(Math.min(first, held[0]!), Math.max(last, held[held.length - 1]!));
    };
    const syncSelection = () => {
      const range = selectionRange();
      if (range) retainSelection(range);
      else if (!pointerDown) release();
    };
    const onSelectionChange = () => flushSync(syncSelection);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const index = rowIndex(target);
      if (
        index < 0 ||
        target.closest(
          'button, input, textarea, [contenteditable], [role="button"], .monaco-editor'
        )
      ) {
        // An OS/context menu can leave the range live while focus changes.
        if (!selectionRange()) flushSync(release);
        return;
      }
      pointerDown = true;
      flushSync(() => {
        if (!selectionRange()) release();
        retain(index, index);
      });
    };
    const onPointerUp = () => {
      pointerDown = false;
      flushSync(syncSelection);
    };
    const onPointerCancel = () => {
      pointerDown = false;
      // iOS can cancel the pointer as native long-press selection takes over.
      // Keep the bounded armed turn until selectionchange or the next interaction.
    };
    const onSelectStart = (event: Event) => {
      const index = rowIndex(event.target instanceof Node ? event.target : null);
      if (index >= 0) flushSync(() => retain(index, index));
    };
    const onScroll = (event: Event) => {
      if (event.target !== viewport) return;
      const range = selectionRange();
      if (range) {
        // Commit keepMounted before Virtua's bubble-phase scroll listener.
        flushSync(() => {
          retainSelection(range);
          retainFrontier();
        });
      } else if (!pointerDown) {
        flushSync(release);
      }
    };
    const onCopy = (event: ClipboardEvent) => {
      const range = selectionRange();
      if (!range) return;
      flushSync(() => retainSelection(range));
      const bounds = rangeRows(range);
      if (!bounds) return;
      const history = current.current.view;
      const mounted = new Set(
        [...viewport.querySelectorAll<HTMLElement>('[data-conversation-row-key]')].map(
          (element) => element.dataset.conversationRowKey
        )
      );
      const selectedRows = current.current.rows.slice(bounds[0], bounds[1] + 1);
      const incomplete = selectedRows.some(
        (row) =>
          !row.ready ||
          (history && !history.isHydrated(history.indexOf(row.turnId))) ||
          !mounted.has(row.key)
      );
      if (incomplete) {
        event.preventDefault();
        current.current.onCopyUnavailable();
      }
    };
    const reconcileRetained = () => {
      if (!retained.current.size) return;
      if (
        [...retained.current].some(([id, held]) =>
          held.lease
            ? (source?.indexOf(id) ?? -1) < 0
            : current.current.view
              ? current.current.view.indexOf(id) < 0
              : !current.current.rows.some((row) => row.turnId === id)
        )
      ) {
        // A real deletion ends selection; pins must never resurrect deleted history.
        if (selectionRange()) doc.getSelection()?.removeAllRanges();
        release();
      } else {
        retainIds(retained.current.keys());
      }
    };
    reconcile.current = reconcileRetained;
    const unsubscribe = source?.subscribe((change) => {
      if (change.kind === 'structure') reconcileRetained();
    });
    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('pointerup', onPointerUp, true);
    doc.addEventListener('pointercancel', onPointerCancel, true);
    doc.addEventListener('selectionchange', onSelectionChange);
    doc.addEventListener('selectstart', onSelectStart, true);
    doc.addEventListener('copy', onCopy, true);
    viewport.addEventListener('scroll', onScroll, true);
    // A pane can mount with a native range already present.
    syncSelection();
    return () => {
      disposed = true;
      reconcile.current = undefined;
      unsubscribe?.();
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('pointerup', onPointerUp, true);
      doc.removeEventListener('pointercancel', onPointerCancel, true);
      doc.removeEventListener('selectionchange', onSelectionChange);
      doc.removeEventListener('selectstart', onSelectStart, true);
      doc.removeEventListener('copy', onCopy, true);
      viewport.removeEventListener('scroll', onScroll, true);
      release();
    };
  }, [sessionId, source, viewport, virtualizer, current, activeRef]);

  useLayoutEffect(() => {
    reconcile.current?.();
  }, [view, rows]);

  for (const row of rows) {
    const turn = retained.current.get(row.turnId);
    if (turn && turn.snapshot === undefined && row.ready)
      turn.snapshot = current.current.captureTurn(row.turnId);
  }
  // Keys/IDs survive insertions and hydration; positional Virtua indices do not.
  const keepMounted = rows.flatMap((row, index) =>
    retained.current.has(row.turnId) ? [index + leadingRowCount] : []
  );
  const holds = new Map([...retained.current].map(([id, turn]) => [id, turn.snapshot]));
  return { activeRef, keepMounted, holds, version };
}
