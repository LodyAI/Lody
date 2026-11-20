import { registerPlainText } from '@lexical/plain-text';
import {
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  KEY_DOWN_COMMAND,
  PASTE_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
  createEditor,
  type LexicalEditor,
} from 'lexical';
import type { FocusIntent, TodayDate, TodayNodeId, TodayNodeView } from '@lody/shared';
import type { TodayPageStore } from '@/lib/today/today-page-store';
import type { TodayPageStoreCache } from '../../../providers/today-page-store-cache';
import {
  $readComposerValue,
  $readSelectionOffsets,
  $setSelectionOffsets,
} from '@/ui/mention/composer-document';
import { caretEdgeLines, offsetFromPoint } from './caret-geometry';
import {
  TODAY_CLIPBOARD_MIME,
  blockRange,
  parseTodayClipboard,
  resolveBlockKey,
  serializeTodayFragments,
  topLevelSelection,
} from './block-selection';
import { readPastedSessionLink } from '@/lib/session-deep-link';
import { projectTodayDrop, type TodayDropRow, type TodayDropTarget } from '../today-dnd';
import { bindLoroText } from './loro-lexical-binding';
import { resolveOutlineKey, type OutlineIntent } from './outline-keys';

export type TodayActiveNode = { store: TodayPageStore; nodeId: TodayNodeId };
export type TodayBlockSelection = { store: TodayPageStore; ids: TodayNodeId[] };
export type TodayDropIndicator =
  | { kind: 'line'; top: number; left: number; width: number }
  | { kind: 'blocked'; x: number; y: number };
export type TodayDragGhost = { x: number; y: number; label: string; count: number };
/** Indentation per outline level; matches the rows' padding. */
export const TODAY_INDENT_PX = 22;
const DRAG_THRESHOLD_PX = 5;

export type TodaySessionPickerState = {
  store: TodayPageStore;
  nodeId: TodayNodeId;
  query: string;
  index: number;
};
const PICKER_TRIGGER = /^[@＠]([^\n]*)$/;
type CaretTarget = number | 'start' | 'end' | { goalX: number; edge: 'top' | 'bottom' };

const isMac = () =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/**
 * One Lexical editor for a whole Today surface, mounted on whichever node is
 * being edited; every other node renders as static text with identical
 * metrics. Structural keys run outline operations through the page undo and
 * hand focus to the resulting node, across days when the caret leaves a page.
 * The page holding the caret is pinned so scrolling never releases it.
 * Behavior: specs/today-outline.md (Outline editing).
 */
export class TodayEditorController {
  readonly editor: LexicalEditor;
  private active: TodayActiveNode | null = null;
  private selection: TodayBlockSelection | null = null;
  private blockAnchor: TodayNodeId | null = null;
  private blockFocus: TodayNodeId | null = null;
  private surface: HTMLElement | null = null;
  private stopPointer: (() => void) | null = null;
  private picker: TodaySessionPickerState | null = null;
  private pickerDismissedFor: TodayNodeId | null = null;
  /** Candidates the picker currently shows, set by its view. */
  pickerItems: readonly string[] = [];
  private dropIndicator: TodayDropIndicator | null = null;
  private dragGhost: TodayDragGhost | null = null;
  /** Opens the node menu for a bullet clicked without dragging (wired by the host). */
  onNodeMenu: ((store: TodayPageStore, nodeId: TodayNodeId, anchor: HTMLElement) => void) | null =
    null;
  /** Workspace whose session links may be pasted into a node. */
  workspaceId: string | null = null;
  /** Builds the plain-text form of a copied session node. */
  sessionLink: (sessionId: string) => string = (sessionId) => sessionId;
  private pendingCaret: CaretTarget = 'end';
  private root: HTMLElement | null = null;
  private binding: { dispose(): void } | null = null;
  private pinnedDocId: string | null = null;
  private readonly days = new Map<TodayDate, TodayPageStore>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly cache: TodayPageStoreCache) {
    this.editor = createEditor({
      namespace: 'lody-today',
      onError: (error) => console.error('Today editor error', error),
    });
    this.cleanups.push(
      registerPlainText(this.editor),
      this.editor.registerCommand(
        KEY_DOWN_COMMAND,
        (event) => this.onKeyDown(event),
        COMMAND_PRIORITY_HIGH
      ),
      this.editor.registerCommand(
        UNDO_COMMAND,
        () => this.history('undo'),
        COMMAND_PRIORITY_CRITICAL
      ),
      this.editor.registerCommand(
        REDO_COMMAND,
        () => this.history('redo'),
        COMMAND_PRIORITY_CRITICAL
      ),
      this.editor.registerCommand(
        KEY_DOWN_COMMAND,
        (event) => this.onPickerKey(event),
        COMMAND_PRIORITY_CRITICAL
      ),
      this.editor.registerCommand(
        PASTE_COMMAND,
        (event) => this.onEditorPaste(event),
        COMMAND_PRIORITY_HIGH
      ),
      this.editor.registerUpdateListener(({ editorState }) => {
        const active = this.active;
        if (!active) return;
        const text = editorState.read(() => $readComposerValue().text);
        const match = PICKER_TRIGGER.exec(text);
        if (match && this.pickerDismissedFor !== active.nodeId) {
          const query = match[1] ?? '';
          if (this.picker?.nodeId === active.nodeId && this.picker.query === query) return;
          this.picker = { store: active.store, nodeId: active.nodeId, query, index: 0 };
          this.notify();
        } else if (this.picker) {
          this.picker = null;
          this.notify();
        }
      }),
      this.editor.registerUpdateListener(({ editorState }) => {
        const active = this.active;
        if (!active) return;
        const offsets = editorState.read(() => $readSelectionOffsets());
        if (offsets) {
          active.store.undo.setSelection({
            nodeId: active.nodeId,
            anchor: offsets.start,
            focus: offsets.end,
          });
        }
      })
    );
  }

  // --- external store for React ------------------------------------------
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getVersion = () => this.version;
  private notify() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
  isActive(store: TodayPageStore, nodeId: TodayNodeId) {
    return this.active?.store === store && this.active.nodeId === nodeId;
  }
  isBlockSelected(store: TodayPageStore, nodeId: TodayNodeId) {
    return this.selection?.store === store && this.selection.ids.includes(nodeId);
  }
  getBlockSelection() {
    return this.selection;
  }
  getPicker() {
    return this.picker;
  }
  getEditorRoot() {
    return this.root;
  }
  getDropIndicator() {
    return this.dropIndicator;
  }
  getDragGhost() {
    return this.dragGhost;
  }

  // --- drag and drop ------------------------------------------------------
  private dayRows(store: TodayPageStore, day: Element) {
    const nodes = new Map(store.getSnapshot().visible.map((node) => [node.id, node] as const));
    const rows: TodayDropRow[] = [];
    let contentLeft = day.getBoundingClientRect().left;
    let right = day.getBoundingClientRect().right;
    for (const element of day.querySelectorAll<HTMLElement>('[data-today-node]')) {
      const node = nodes.get(element.dataset.todayNode as TodayNodeId);
      if (!node) continue;
      const rect = element.getBoundingClientRect();
      if (node.depth === 0) {
        contentLeft = rect.left;
        right = rect.right;
      }
      rows.push({
        id: node.id,
        parentId: node.parentId,
        depth: node.depth,
        top: rect.top,
        bottom: rect.bottom,
        collapsed: node.collapsed && node.hasChildren,
      });
    }
    return { rows, contentLeft, right };
  }

  private project(
    store: TodayPageStore,
    day: Element,
    point: { x: number; y: number },
    excluded: ReadonlySet<string>
  ): TodayDropTarget | null {
    const { rows, contentLeft, right } = this.dayRows(store, day);
    const target = projectTodayDrop(rows, point, contentLeft, TODAY_INDENT_PX, excluded);
    this.dropIndicator = target
      ? {
          kind: 'line',
          top: target.lineTop,
          left: target.lineLeft,
          width: Math.max(right - target.lineLeft, 40),
        }
      : null;
    return target;
  }

  /** Move nodes (or insert a session node) where a drop target points. */
  private dropAt(
    store: TodayPageStore,
    target: TodayDropTarget,
    ids: readonly TodayNodeId[] | null,
    sessionId?: string
  ) {
    const moving = new Set<string>(ids ?? []);
    const siblings = store.outline
      .getAllNodes()
      .filter((node) => node.parentId === target.parentId && !moving.has(node.id));
    const index =
      target.after === null
        ? 0
        : target.after === 'end'
          ? siblings.length
          : siblings.findIndex((node) => node.id === target.after) + 1;
    const parentId = target.parentId as TodayNodeId | null;
    store.undo.structural(() => {
      if (target.expandParent && parentId) store.outline.setCollapsed(parentId, false);
      if (ids) store.outline.moveTo(ids, { parentId, index });
      else if (sessionId) store.outline.insertSessionNode({ parentId, index }, sessionId);
    });
  }

  /**
   * Bullet pressed: after 5px it drags the node (or the whole block selection
   * it belongs to) within its day; a press without movement opens the menu.
   */
  beginNodeDrag(
    store: TodayPageStore,
    nodeId: TodayNodeId,
    bullet: HTMLElement,
    start: { clientX: number; clientY: number }
  ) {
    const day = bullet.closest('[data-today-date]');
    if (!day) return;
    this.stopPointer?.();
    const selection =
      this.selection?.store === store && this.selection.ids.includes(nodeId)
        ? this.selection.ids
        : [nodeId];
    const ids = topLevelSelection(store.getSnapshot().visible, selection);
    const label = store.outline.getNode(ids[0]!)?.text ?? '';
    let dragging = false;
    let target: TodayDropTarget | null = null;
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
      this.stopPointer = null;
      const wasDragging = dragging;
      const drop = target;
      this.dropIndicator = null;
      this.dragGhost = null;
      if (wasDragging) this.notify();
      if (commit && wasDragging && drop) this.dropAt(store, drop, ids);
      if (commit && !wasDragging) this.onNodeMenu?.(store, nodeId, bullet);
    };
    const move = (event: PointerEvent) => {
      if (
        !dragging &&
        Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < DRAG_THRESHOLD_PX
      )
        return;
      if (!dragging) {
        dragging = true;
        this.deactivate(false);
      }
      const rect = day.getBoundingClientRect();
      const inside = event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (inside) {
        target = this.project(store, day, { x: event.clientX, y: event.clientY }, new Set(ids));
      } else {
        target = null;
        this.dropIndicator = { kind: 'blocked', x: event.clientX, y: event.clientY };
      }
      this.dragGhost = { x: event.clientX, y: event.clientY, label, count: ids.length };
      this.notify();
    };
    const up = () => finish(true);
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !dragging) return;
      // Esc only cancels the drag; it must not also enter block selection.
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, true);
    this.stopPointer = () => finish(false);
  }

  /** A conversation dragged from the sidebar hovers at (x, y). */
  hoverExternal(x: number, y: number): TodayDropTarget | null {
    const located = this.dayAt(x, y);
    const target = located ? this.project(located.store, located.day, { x, y }, new Set()) : null;
    if (!target) this.dropIndicator = null;
    this.notify();
    return target;
  }

  leaveExternal() {
    if (!this.dropIndicator) return;
    this.dropIndicator = null;
    this.notify();
  }

  /** A conversation dropped from the sidebar: a new session node at the line. */
  dropExternal(sessionId: string, x: number, y: number) {
    const located = this.dayAt(x, y);
    const target = located ? this.project(located.store, located.day, { x, y }, new Set()) : null;
    this.dropIndicator = null;
    this.notify();
    if (located && target) this.dropAt(located.store, target, null, sessionId);
  }

  private dayAt(x: number, y: number) {
    const stack =
      typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(x, y) : [];
    for (const element of stack) {
      const day = element.closest('[data-today-date]');
      const store = day && this.days.get(day.getAttribute('data-today-date') as TodayDate);
      if (day && store) return { day, store };
    }
    return null;
  }

  private onPickerKey(event: KeyboardEvent): boolean {
    const picker = this.picker;
    if (!picker || event.isComposing || event.keyCode === 229) return false;
    const count = this.pickerItems.length;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (count === 0) return false;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.picker = { ...picker, index: (picker.index + step + count) % count };
        break;
      }
      case 'Enter':
      case 'Tab': {
        const sessionId = this.pickerItems[picker.index];
        if (!sessionId) return false;
        event.preventDefault();
        queueMicrotask(() => this.acceptPicker(sessionId));
        return true;
      }
      case 'Escape':
        this.pickerDismissedFor = picker.nodeId;
        this.picker = null;
        break;
      default:
        return false;
    }
    event.preventDefault();
    event.stopPropagation();
    this.notify();
    return true;
  }

  /** Turn the `@query` node into a session node; one undo brings `@query` back. */
  acceptPicker(sessionId: string) {
    const picker = this.picker;
    if (!picker) return;
    this.picker = null;
    const { store, nodeId } = picker;
    this.deactivate(false);
    store.undo.structural(() => store.outline.convertToSession(nodeId, sessionId));
    this.selectBlocks(store, [nodeId]);
  }

  /** Sections register their open page so the caret can cross days. */
  registerDay(date: TodayDate, store: TodayPageStore) {
    this.days.set(date, store);
    return () => {
      if (this.days.get(date) === store) this.days.delete(date);
    };
  }

  // --- activation ---------------------------------------------------------
  activate(store: TodayPageStore, nodeId: TodayNodeId, caret: CaretTarget) {
    const node = store.outline.getNode(nodeId);
    if (!node) return;
    if (node.kind === 'session') {
      this.selectBlocks(store, [nodeId]);
      return;
    }
    this.selection = null;
    this.pendingCaret = caret;
    if (this.isActive(store, nodeId) && this.root) {
      this.placeCaret();
      return;
    }
    this.pin(store.docId);
    this.active = { store, nodeId };
    if (this.pickerDismissedFor !== nodeId) this.pickerDismissedFor = null;
    this.notify();
  }

  selectBlocks(
    store: TodayPageStore,
    ids: TodayNodeId[],
    ends: { anchor?: TodayNodeId; focus?: TodayNodeId } = {}
  ) {
    if (ids.length === 0) return;
    this.deactivate(false);
    this.pin(store.docId);
    this.selection = { store, ids };
    this.blockAnchor = ends.anchor ?? ids[0]!;
    this.blockFocus = ends.focus ?? ids.at(-1)!;
    store.undo.setSelection({ blockSelect: ids });
    window.getSelection()?.removeAllRanges();
    this.surface?.focus({ preventScroll: true });
    this.notify();
  }

  clearBlockSelection() {
    if (!this.selection) return;
    this.selection = null;
    this.notify();
  }

  /** The scroll surface: owns focus, keys and clipboard while blocks are selected. */
  attachSurface = (element: HTMLElement | null) => {
    this.surface = element;
  };

  /** Keys on the surface while blocks are selected. Returns true when handled. */
  onBlockKey(event: KeyboardEvent): boolean {
    const selection = this.selection;
    if (!selection) return false;
    const intent = resolveBlockKey(event, isMac() ? 'mac' : 'other');
    if (!intent) return false;
    event.preventDefault();
    const { store } = selection;
    const outline = store.outline;
    const visible = store.getSnapshot().visible;
    const roots = topLevelSelection(visible, selection.ids);
    const focusIndex = visible.findIndex((node) => node.id === this.blockFocus);
    const keep = () =>
      this.selectBlocks(store, selection.ids, {
        anchor: this.blockAnchor ?? undefined,
        focus: this.blockFocus ?? undefined,
      });
    switch (intent.type) {
      case 'clear':
        this.clearBlockSelection();
        return true;
      case 'edit': {
        const node = visible.find((candidate) => candidate.id === this.blockFocus);
        if (!node) return true;
        if (node.kind === 'session') this.onOpenSession?.(node.sessionId!, event);
        else this.activate(store, node.id, 'end');
        return true;
      }
      case 'delete':
        this.clearBlockSelection();
        this.apply(
          store,
          store.undo.structural(() => outline.deleteNodes(roots))
        );
        return true;
      case 'step': {
        const next = visible[focusIndex + intent.step];
        if (next) this.selectBlocks(store, [next.id]);
        return true;
      }
      case 'extend': {
        const next = visible[focusIndex + intent.step];
        if (!next || !this.blockAnchor) return true;
        this.selectBlocks(store, blockRange(visible, this.blockAnchor, next.id), {
          anchor: this.blockAnchor,
          focus: next.id,
        });
        return true;
      }
      case 'select-all':
        this.selectBlocks(
          store,
          visible.map((node) => node.id)
        );
        return true;
      case 'indent':
        store.undo.structural(() => outline.indent(roots));
        keep();
        return true;
      case 'outdent':
        store.undo.structural(() => outline.outdent(roots));
        keep();
        return true;
      case 'move-up':
        store.undo.structural(() => outline.moveUp(roots));
        keep();
        return true;
      case 'move-down':
        store.undo.structural(() => outline.moveDown(roots));
        keep();
        return true;
    }
  }

  /** Copy or cut the selected blocks (surface `copy`/`cut` events). */
  onBlockClipboard(event: ClipboardEvent, cut: boolean): boolean {
    const selection = this.selection;
    if (!selection || !event.clipboardData) return false;
    const { store } = selection;
    const roots = topLevelSelection(store.getSnapshot().visible, selection.ids);
    const fragments = store.outline.extract(roots);
    event.preventDefault();
    event.clipboardData.setData('text/plain', serializeTodayFragments(fragments, this.sessionLink));
    event.clipboardData.setData(TODAY_CLIPBOARD_MIME, JSON.stringify({ v: 1, fragments }));
    if (cut) {
      this.clearBlockSelection();
      this.apply(
        store,
        store.undo.structural(() => store.outline.deleteNodes(roots))
      );
    }
    return true;
  }

  /** Paste after the selected blocks. */
  onBlockPaste(event: ClipboardEvent): boolean {
    const selection = this.selection;
    const fragments = event.clipboardData && readClipboard(event.clipboardData);
    if (!selection || !fragments) return false;
    event.preventDefault();
    const { store } = selection;
    const roots = topLevelSelection(store.getSnapshot().visible, selection.ids);
    const after = roots.at(-1);
    if (!after) return true;
    this.apply(
      store,
      store.undo.structural(() => store.outline.paste({ kind: 'after', nodeId: after }, fragments))
    );
    return true;
  }

  private onEditorPaste(event: ClipboardEvent | InputEvent | KeyboardEvent | null): boolean {
    const active = this.active;
    if (!active || !(event instanceof ClipboardEvent) || !event.clipboardData) return false;
    const data = event.clipboardData;
    const structured = data.getData(TODAY_CLIPBOARD_MIME);
    const text = data.getData('text/plain');
    const empty = this.editor.getEditorState().read(() => $readComposerValue().text) === '';
    const link = empty && !structured ? readPastedSessionLink(text, this.workspaceId) : null;
    if (link) {
      event.preventDefault();
      const { store, nodeId } = active;
      queueMicrotask(() => {
        this.deactivate(false);
        store.undo.structural(() => store.outline.convertToSession(nodeId, link.sessionId));
        this.selectBlocks(store, [nodeId]);
      });
      return true;
    }
    if (!structured && !text.includes('\n')) return false;
    const fragments = readClipboard(data);
    if (!fragments) return false;
    event.preventDefault();
    const offset = this.editor.getEditorState().read(() => $readSelectionOffsets())?.start ?? 0;
    const { store, nodeId } = active;
    queueMicrotask(() =>
      this.apply(
        store,
        store.undo.structural(() =>
          store.outline.paste({ kind: 'text', nodeId, offset }, fragments)
        )
      )
    );
    return true;
  }

  /** Opens a session node (wired by the host). */
  onOpenSession:
    | ((sessionId: string, event?: { metaKey?: boolean; ctrlKey?: boolean }) => void)
    | null = null;

  /**
   * Pointer pressed on a row: edit it, or extend a block selection with Shift.
   * Dragging onto another row of the same day turns the gesture into a block
   * selection; dragging back onto the starting row returns to text editing.
   */
  pointerDown(
    store: TodayPageStore,
    nodeId: TodayNodeId,
    element: HTMLElement,
    event: { clientX: number; clientY: number; shiftKey: boolean }
  ) {
    const extendFrom =
      this.selection?.store === store
        ? this.blockAnchor
        : this.active?.store === store
          ? this.active.nodeId
          : null;
    if (event.shiftKey && extendFrom) {
      const visible = store.getSnapshot().visible;
      this.selectBlocks(store, blockRange(visible, extendFrom, nodeId), {
        anchor: extendFrom,
        focus: nodeId,
      });
      return;
    }
    // Read the day before activation: activating replaces this static element.
    const day = element.closest('[data-today-date]');
    this.activateAtPoint(store, nodeId, element, event.clientX, event.clientY);
    this.trackDrag(store, nodeId, day);
  }

  private trackDrag(store: TodayPageStore, anchor: TodayNodeId, day: Element | null) {
    this.stopPointer?.();
    if (!day) return;
    const rowAt = (y: number): TodayNodeId | null => {
      const rows = [...day.querySelectorAll<HTMLElement>('[data-today-node]')];
      let best: HTMLElement | undefined;
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (y < rect.top) break;
        best = row;
      }
      return (
        (best?.dataset.todayNode as TodayNodeId | undefined) ??
        (rows[0]?.dataset.todayNode as TodayNodeId | undefined) ??
        null
      );
    };
    const move = (event: PointerEvent) => {
      if ((event.buttons & 1) === 0) return stop();
      const target = rowAt(event.clientY);
      if (!target) return;
      if (target !== anchor) {
        const visible = store.getSnapshot().visible;
        this.selectBlocks(store, blockRange(visible, anchor, target), { anchor, focus: target });
      } else if (this.selection) {
        this.activate(store, anchor, 'end');
      }
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('blur', stop);
      this.stopPointer = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('blur', stop);
    this.stopPointer = stop;
  }

  deactivate(notify = true) {
    this.binding?.dispose();
    this.binding = null;
    this.active?.store.undo.endGroup();
    this.active = null;
    this.editor.setRootElement(null);
    this.root = null;
    if (notify) this.notify();
  }

  /** Ref callback of the active row's editable element. */
  attachRoot = (element: HTMLElement | null) => {
    if (element === this.root) return;
    this.binding?.dispose();
    this.binding = null;
    this.root = element;
    this.editor.setRootElement(element);
    const active = this.active;
    if (!element || !active) return;
    // Lexical writes inline white-space; the shared stylesheet owns wrapping.
    element.style.removeProperty('white-space');
    element.style.removeProperty('word-break');
    const text = active.store.outline.getText(active.nodeId);
    if (!text) return;
    this.binding = bindLoroText({
      editor: this.editor,
      text,
      undo: active.store.undo,
      isComposing: () => this.editor.isComposing(),
    });
    this.placeCaret();
    element.focus({ preventScroll: true });
  };

  private placeCaret() {
    const root = this.root;
    const caret = this.pendingCaret;
    const length = this.editor.getEditorState().read(() => $readComposerValue().text.length);
    let offset = 0;
    if (caret === 'end') offset = length;
    else if (typeof caret === 'number') offset = Math.min(caret, length);
    else if (typeof caret === 'object' && root)
      offset = offsetFromPoint(root, caret.goalX, caret.edge);
    this.editor.update(() => $setSelectionOffsets(offset), { discrete: true });
    root?.scrollIntoView?.({ block: 'nearest' });
  }

  /** Static node clicked: edit it with the caret under the pointer. */
  activateAtPoint(
    store: TodayPageStore,
    nodeId: TodayNodeId,
    element: HTMLElement,
    x: number,
    y: number
  ) {
    this.activate(store, nodeId, offsetFromPoint(element, x, y));
  }

  /** Empty page placeholder clicked or typed into. */
  startPage(store: TodayPageStore) {
    const focus = store.undo.structural(() => store.outline.insertFirst(''));
    this.apply(store, focus);
  }

  // --- keys ---------------------------------------------------------------
  private onKeyDown(event: KeyboardEvent): boolean {
    const active = this.active;
    const root = this.root;
    if (!active || !root) return false;
    const state = this.editor.getEditorState().read(() => ({
      offsets: $readSelectionOffsets(),
      length: $readComposerValue().text.length,
    }));
    const offsets = state.offsets ?? { start: state.length, end: state.length };
    const lines = caretEdgeLines(root);
    const intent = resolveOutlineKey(
      event,
      {
        offset: offsets.start,
        length: state.length,
        hasSelection: offsets.start !== offsets.end,
        onFirstLine: lines.first,
        onLastLine: lines.last,
      },
      isMac() ? 'mac' : 'other'
    );
    if (!intent) return false;
    event.preventDefault();
    const goalX = lines.caretX;
    // Lexical commands run inside an update; outline writes happen right after.
    queueMicrotask(() => this.run(active, intent, offsets.start, goalX));
    return true;
  }

  private run(active: TodayActiveNode, intent: OutlineIntent, offset: number, goalX: number) {
    const { store, nodeId } = active;
    const outline = store.outline;
    const keepCaret = () => this.activate(store, nodeId, offset);
    switch (intent.type) {
      case 'split':
        return this.apply(
          store,
          store.undo.structural(() => outline.split(nodeId, offset))
        );
      case 'enter-empty':
        return this.apply(
          store,
          store.undo.structural(() => outline.enterOnEmpty(nodeId))
        );
      case 'merge-previous':
        return this.apply(
          store,
          store.undo.structural(() => outline.mergeWithPrevious(nodeId))
        );
      case 'merge-next':
        return this.apply(
          store,
          store.undo.structural(() => outline.mergeWithNext(nodeId))
        );
      case 'indent':
        store.undo.structural(() => outline.indent([nodeId]));
        return keepCaret();
      case 'outdent':
        store.undo.structural(() => outline.outdent([nodeId]));
        return keepCaret();
      case 'move-up':
        store.undo.structural(() => outline.moveUp([nodeId]));
        return keepCaret();
      case 'move-down':
        store.undo.structural(() => outline.moveDown([nodeId]));
        return keepCaret();
      case 'collapse':
      case 'expand':
        store.undo.structural(() => outline.setCollapsed(nodeId, intent.type === 'collapse'));
        return keepCaret();
      case 'focus-previous':
        return this.focusNeighbour(store, nodeId, -1, { goalX, edge: 'bottom' });
      case 'focus-next':
        return this.focusNeighbour(store, nodeId, 1, { goalX, edge: 'top' });
      case 'focus-previous-end':
        return this.focusNeighbour(store, nodeId, -1, 'end');
      case 'focus-next-start':
        return this.focusNeighbour(store, nodeId, 1, 'start');
      case 'block-select':
        return this.selectBlocks(store, [nodeId]);
    }
  }

  apply(store: TodayPageStore, focus: FocusIntent) {
    if (!focus) return;
    if ('blockSelect' in focus) this.selectBlocks(store, focus.blockSelect);
    else this.activate(store, focus.nodeId, focus.offset);
  }

  /** Visible neighbour in the stream, crossing into the adjacent day at a page edge. */
  private focusNeighbour(
    store: TodayPageStore,
    nodeId: TodayNodeId,
    step: -1 | 1,
    caret: CaretTarget
  ) {
    const visible = store.getSnapshot().visible;
    const index = visible.findIndex((node) => node.id === nodeId);
    const inPage = index < 0 ? undefined : visible[index + step];
    if (inPage) return this.focusNode(store, inPage, caret);
    const ordered = [...this.days.entries()].sort(([a], [b]) => (a < b ? 1 : -1));
    const dayIndex = ordered.findIndex(([, page]) => page === store);
    for (let next = dayIndex + step; next >= 0 && next < ordered.length; next += step) {
      const page = ordered[next]![1];
      const nodes = page.getSnapshot().visible;
      const target = step === 1 ? nodes[0] : nodes.at(-1);
      if (target) return this.focusNode(page, target, caret);
    }
  }

  private focusNode(store: TodayPageStore, node: TodayNodeView, caret: CaretTarget) {
    if (node.kind === 'session') this.selectBlocks(store, [node.id]);
    else this.activate(store, node.id, caret);
  }

  private history(direction: 'undo' | 'redo'): boolean {
    const store = this.active?.store ?? this.selection?.store;
    if (!store) return false;
    queueMicrotask(() => {
      const stop = store.undo.onRestore((intent) => this.apply(store, intent));
      if (direction === 'undo') store.undo.undo();
      else store.undo.redo();
      stop();
    });
    return true;
  }

  private pin(docId: string) {
    if (this.pinnedDocId === docId) return;
    const previous = this.pinnedDocId;
    this.pinnedDocId = docId;
    void this.cache.acquire(docId);
    if (previous) this.cache.releaseRef(previous);
  }

  dispose() {
    this.stopPointer?.();
    this.deactivate(false);
    if (this.pinnedDocId) this.cache.releaseRef(this.pinnedDocId);
    this.pinnedDocId = null;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.listeners.clear();
  }
}

function readClipboard(data: DataTransfer) {
  return parseTodayClipboard({
    json: data.getData(TODAY_CLIPBOARD_MIME) || undefined,
    text: data.getData('text/plain') || undefined,
  });
}
