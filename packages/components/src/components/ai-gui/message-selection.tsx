import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ImageIcon } from 'lucide-react';
import type { ConversationMessage } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { ConversationColumn } from '@/components/shared/conversation-column';

type SelectionGesture = {
  anchor: string;
  base: ReadonlySet<string>;
  select: boolean;
  invert: boolean;
  last: string | null;
  scrollRoot: HTMLElement | null;
  origin: { x: number; y: number } | null;
};

export function useMessageSelection(scopeId = '') {
  const anchor = useRef<string | null>(null);
  const gesture = useRef<SelectionGesture | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState(scopeId);
  const [selection, setSelection] = useState<{
    messages: ConversationMessage[];
    ids: ReadonlySet<string>;
    onConfirm: (messages: ConversationMessage[]) => void;
  } | null>(null);
  if (scope !== scopeId) {
    setScope(scopeId);
    setSelection(null);
    gesture.current = null;
    anchor.current = null;
  }
  const start = useCallback(
    (candidates: ConversationMessage[], onConfirm: (messages: ConversationMessage[]) => void) => {
      anchor.current = null;
      gesture.current = null;
      if (overlayRef.current) overlayRef.current.hidden = true;
      setSelection({ messages: candidates, ids: new Set(), onConfirm });
    },
    []
  );
  const cancel = useCallback(() => {
    gesture.current = null;
    setSelection(null);
  }, []);
  const extend = useCallback((id: string) => {
    const drag = gesture.current;
    if (!drag || drag.last === id) return;
    drag.last = id;
    setSelection((current) => {
      if (!current) return current;
      const from = current.messages.findIndex((message) => message.id === drag.anchor);
      const to = current.messages.findIndex((message) => message.id === id);
      if (from < 0 || to < 0) return current;
      const ids = new Set(drag.base);
      for (const message of current.messages.slice(Math.min(from, to), Math.max(from, to) + 1)) {
        if (drag.invert ? !drag.base.has(message.id) : drag.select) ids.add(message.id);
        else ids.delete(message.id);
      }
      return { ...current, ids };
    });
  }, []);
  const active = selection !== null;
  useEffect(() => {
    if (!active) return undefined;
    let frame = 0;
    let x = 0;
    let y = 0;
    let previousTime: number | null = null;
    const overlay = overlayRef.current;
    const paintOverlay = () => {
      const drag = gesture.current;
      const root = drag?.scrollRoot;
      if (!root || !drag.origin || !overlay) return;
      const bounds = root.getBoundingClientRect();
      const endX = Math.max(0, Math.min(bounds.width, x - bounds.left)) + root.scrollLeft;
      const endY = Math.max(0, Math.min(bounds.height, y - bounds.top)) + root.scrollTop;
      const width = Math.abs(endX - drag.origin.x);
      const height = Math.abs(endY - drag.origin.y);
      overlay.hidden = Math.max(width, height) < 4;
      overlay.style.left = `${Math.min(endX, drag.origin.x)}px`;
      overlay.style.top = `${Math.min(endY, drag.origin.y)}px`;
      overlay.style.width = `${Math.max(1, width)}px`;
      overlay.style.height = `${Math.max(1, height)}px`;
    };
    const hitTest = () => {
      const root = gesture.current?.scrollRoot;
      if (!root) return;
      const bounds = root.getBoundingClientRect();
      const element = document.elementFromPoint(
        Math.max(bounds.left + 1, Math.min(bounds.right - 1, x)),
        Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, y))
      );
      if (!element || !root.contains(element)) return;
      const id = element.closest<HTMLElement>('[data-message-selection-id]')?.dataset
        .messageSelectionId;
      if (id) extend(id);
    };
    const tick = (time: number) => {
      const root = gesture.current?.scrollRoot;
      if (!root) {
        frame = 0;
        return;
      }
      const bounds = root.getBoundingClientRect();
      const edge = 48;
      const speed =
        y < bounds.top + edge
          ? -Math.min(1, (bounds.top + edge - y) / edge)
          : y > bounds.bottom - edge
            ? Math.min(1, (y - bounds.bottom + edge) / edge)
            : 0;
      root.scrollTop += speed * Math.min(32, previousTime === null ? 0 : time - previousTime) * 0.7;
      previousTime = time;
      hitTest();
      paintOverlay();
      frame = requestAnimationFrame(tick);
    };
    const move = (event: PointerEvent) => {
      if (!gesture.current) return;
      x = event.clientX;
      y = event.clientY;
      const root = gesture.current.scrollRoot;
      if (root && !gesture.current.origin) {
        const bounds = root.getBoundingClientRect();
        gesture.current.origin = {
          x: x - bounds.left + root.scrollLeft,
          y: y - bounds.top + root.scrollTop,
        };
      }
      hitTest();
      paintOverlay();
      if (!frame && gesture.current.scrollRoot) frame = requestAnimationFrame(tick);
    };
    const end = () => {
      gesture.current = null;
      if (overlay) overlay.hidden = true;
      cancelAnimationFrame(frame);
      frame = 0;
      previousTime = null;
    };
    window.addEventListener('pointerdown', move);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
    return () => {
      end();
      window.removeEventListener('pointerdown', move);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
    };
  }, [active, extend]);
  const messages = useMemo(
    () => selection?.messages.filter((message) => selection.ids.has(message.id)) ?? [],
    [selection]
  );
  const context = useMemo(
    () =>
      selection
        ? {
            ids: selection.ids,
            overlayRef,
            availableIds: new Set(selection.messages.map((message) => message.id)),
            begin: (
              id: string,
              shift: boolean,
              invert: boolean,
              scrollRoot: HTMLElement | null
            ) => {
              gesture.current = {
                anchor: shift && anchor.current ? anchor.current : id,
                base: selection.ids,
                select: shift || !selection.ids.has(id),
                invert,
                last: null,
                scrollRoot,
                origin: null,
              };
              if (!shift || !anchor.current) anchor.current = id;
              extend(id);
            },
            extend,
            toggle: (id: string) =>
              setSelection((current) => {
                if (!current || !current.messages.some((message) => message.id === id))
                  return current;
                const ids = new Set(current.ids);
                anchor.current = id;
                if (ids.has(id)) ids.delete(id);
                else ids.add(id);
                return { ...current, ids };
              }),
          }
        : null,
    [selection, extend]
  );
  return {
    active: selection !== null,
    messages,
    start,
    cancel,
    confirm: () => {
      if (messages.length) selection?.onConfirm(messages);
    },
    allSelected: !!selection && messages.length === selection.messages.length,
    toggleAll: () =>
      setSelection(
        (current) =>
          current && {
            ...current,
            ids:
              current.ids.size === current.messages.length
                ? new Set()
                : new Set(current.messages.map((message) => message.id)),
          }
      ),
    context,
  };
}

export const MessageSelectionContext = createContext<{
  overlayRef: RefObject<HTMLDivElement | null>;
  ids: ReadonlySet<string>;
  availableIds: ReadonlySet<string>;
  toggle: (id: string) => void;
  begin: (id: string, shift: boolean, invert: boolean, scrollRoot: HTMLElement | null) => void;
  extend: (id: string) => void;
} | null>(null);

export function MessageSelectionOverlay() {
  const selection = useContext(MessageSelectionContext);
  return (
    <div
      ref={selection?.overlayRef}
      hidden
      aria-hidden="true"
      data-message-selection-overlay=""
      className="pointer-events-none absolute z-20 border border-primary bg-primary/15"
    />
  );
}

export function MessageSelectionRow({
  id,
  first,
  children,
}: {
  id?: string;
  first: boolean;
  children: ReactNode;
}) {
  const selection = useContext(MessageSelectionContext);
  const { t } = useTranslation();
  const handledPointer = useRef(false);
  const selectable = !!id && selection?.availableIds.has(id);
  const selected = !!id && selection?.ids.has(id);
  return (
    <div
      className={`relative ${selectable ? 'flow-root select-none cursor-default' : ''} ${selected ? 'bg-primary/10' : ''}`}
      data-message-selection-id={selectable ? id : undefined}
      onPointerDownCapture={
        selectable
          ? (event) => {
              handledPointer.current = false;
              if (event.button !== 0 || event.pointerType === 'touch') return;
              const target = event.target as HTMLElement;
              if (
                !target.closest('[data-message-selection-checkbox]') &&
                target.closest('button, a, input, textarea, select, summary, [role="button"]')
              )
                return;
              event.preventDefault();
              handledPointer.current = true;
              selection?.begin(
                id,
                event.shiftKey,
                event.metaKey || event.ctrlKey,
                event.currentTarget.closest('[data-message-selection-scroll]')
              );
            }
          : undefined
      }
      onPointerEnter={selectable ? () => selection?.extend(id) : undefined}
      onClickCapture={
        selectable
          ? (event) => {
              if (handledPointer.current) {
                handledPointer.current = false;
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              if (
                (event.target as HTMLElement).closest(
                  'button, a, input, textarea, select, summary, [role="button"], [role="checkbox"]'
                ) ||
                window.getSelection()?.toString()
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              selection?.toggle(id);
            }
          : undefined
      }
    >
      {selectable && first ? (
        <ConversationColumn className="pointer-events-none relative h-0">
          <Checkbox
            data-message-selection-checkbox=""
            className="pointer-events-auto absolute left-0 top-3"
            checked={selected}
            onCheckedChange={() => selection?.toggle(id)}
            aria-label={t('sessions.shareImage.selectMessage', 'Select message')}
          />
        </ConversationColumn>
      ) : null}
      <div className={selectable ? 'pl-7' : undefined}>{children}</div>
    </div>
  );
}

export function MessageSelectionToolbar({
  selection,
}: {
  selection: ReturnType<typeof useMessageSelection>;
}) {
  const { t } = useTranslation();
  const { active, cancel } = selection;
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest('[role="dialog"], [role="alertdialog"]'))
      )
        return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, cancel]);
  if (!selection.active) return null;
  return (
    <ConversationColumn className="flex flex-wrap items-center gap-2 border-t py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <span className="mr-auto text-sm" role="status">
        {t('sessions.shareImage.selectedCount', '{{count}} selected', {
          count: selection.messages.length,
        })}
      </span>
      <Button variant="ghost" size="small" onClick={selection.toggleAll}>
        {selection.allSelected
          ? t('sessions.shareImage.clearSelection', 'Clear selection')
          : t('sessions.shareImage.selectAll', 'Select all')}
      </Button>
      <Button variant="ghost" size="small" onClick={selection.cancel}>
        {t('common.cancel', 'Cancel')}
      </Button>
      <Button size="small" disabled={!selection.messages.length} onClick={selection.confirm}>
        <ImageIcon className="size-4" />
        {t('sessions.shareImage.preview', 'Preview image')}
      </Button>
    </ConversationColumn>
  );
}
