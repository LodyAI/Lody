import { registerPlainText } from '@lexical/plain-text';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  COPY_COMMAND,
  CUT_COMMAND,
  KEY_DOWN_COMMAND,
  PASTE_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
  createEditor,
  type LexicalEditor,
} from 'lexical';
import {
  sliceTodayRich,
  type FocusIntent,
  type TodayFragment,
  type TodayDate,
  type TodayNodeView,
  type TodayMentionTarget,
  type TodayNodeId,
} from '@lody/shared';
import type { TodayPageStore } from '@/lib/today/today-page-store';
import type { TodayPageStoreCache } from '../../../providers/today-page-store-cache';
import { MentionDecoratorNode } from '@/ui/mention/mention-node';
import {
  $domPointToOffset,
  $ensureMentionCaretTarget,
  $readComposerValue,
  $readSelectionOffsets,
  $setSelectionOffsets,
} from '@/ui/mention/composer-document';
import { caretEdgeLines, offsetFromPoint } from './caret-geometry';
import {
  TODAY_CLIPBOARD_MIME,
  TODAY_CLIPBOARD_VERSION,
  blockRange,
  parseTodayClipboard,
  resolveBlockKey,
  escalateSelection,
  extendFocus,
  selectionCovers,
  linkifyTodayFragments,
  linkifyTodayText,
  serializeTodayFragments,
  todayRichToPlain,
  topLevelSelection,
  type TodayMentionText,
} from './block-selection';
import { MENTION_KEYS, resolveMentionKey } from './mention-keys';
import { readPastedSessionLink } from '@/lib/session-deep-link';
import { projectTodayDrop, type TodayDropRow, type TodayDropTarget } from '../today-dnd';
import { $readTodayEditorRich, bindLoroText } from './loro-lexical-binding';
import { isImeKey, resolveOutlineKey, type OutlineIntent } from './outline-keys';
import { isMac } from '@/lib/commands/platform';

export type TodayActiveNode = { store: TodayPageStore; nodeId: TodayNodeId };
export type TodayBlockSelection = { store: TodayPageStore; ids: TodayNodeId[] };
export type TodayDropIndicator =
  | { kind: 'line'; top: number; left: number; width: number }
  | { kind: 'blocked'; x: number; y: number };
export type TodayDragGhost = {
  x: number;
  y: number;
  label: string;
  count: number;
  /** Released: gliding to where it landed, or back home (~100ms), then gone. */
  settling?: boolean;
};
/** Indentation per outline level; matches the rows' padding. */
export const TODAY_INDENT_PX = 22;

/** What a press on the surface leaves alone: rows and controls handle their own. */
const SURFACE_CONTENT =
  '[data-today-node], button, a, input, textarea, [contenteditable="true"], [role="menu"], [role="dialog"]';

/** Distance from a row's start to its bullet's centre (12px fold toggle + half the 16px bullet box). */
const TODAY_BULLET_CENTER_PX = 20;
const DRAG_THRESHOLD_PX = 5;
/** Hovering where a drop would go into a folded node unfolds it after this long. */
const DRAG_UNFOLD_DELAY_MS = 500;
/** How long the released card glides before it disappears. */
const DRAG_SETTLE_MS = 120;

/** The structural moves the node editor and block selection share; `within` is the zoomed root. */
const OUTLINE_MOVES = {
  indent: (outline, ids) => outline.indent(ids),
  outdent: (outline, ids, within) => outline.outdent(ids, { within }),
  'move-up': (outline, ids) => outline.moveUp(ids),
  'move-down': (outline, ids) => outline.moveDown(ids),
} satisfies Record<
  string,
  (outline: TodayPageStore['outline'], ids: TodayNodeId[], within?: TodayNodeId) => unknown
>;

export type TodaySessionPickerState = {
  store: TodayPageStore;
  nodeId: TodayNodeId;
  query: string;
  index: number;
  /** Offset of the `@`; the mention replaces `start..start + 1 + query.length`. */
  start: number;
  tab: TodayPickerTab;
};
export type TodayPickerTab = 'all' | 'member' | 'session';
/**
 * An `@` (or full-width `＠`) at the line start or after whitespace, then the
 * query up to the caret: no newline and no other mention inside it.
 */
const PICKER_TRIGGER = /(?:^|[\s\uFFFC])([@＠])([^\n\uFFFC]*)$/;

/** The open picker, if the caret ends an `@query`. */
export function findPickerTrigger(
  text: string,
  caret: number
): { start: number; query: string } | null {
  const match = PICKER_TRIGGER.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
}
type CaretTarget =
  | number
  | 'start'
  | 'end'
  | { goalX: number; edge: 'top' | 'bottom' }
  | { anchor: number; focus: number };

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
  /** Text selection a Shift+Up/Down block selection came from; Esc restores it. */
  private textOrigin: {
    store: TodayPageStore;
    nodeId: TodayNodeId;
    anchor: number;
    focus: number;
  } | null = null;
  private coveredFor: {
    snapshot: unknown;
    ids: readonly TodayNodeId[];
    covered: Set<TodayNodeId>;
  } | null = null;
  private blockFocus: TodayNodeId | null = null;
  private surface: HTMLElement | null = null;
  private stopPointer: (() => void) | null = null;
  private picker: TodaySessionPickerState | null = null;
  /** The `@` the user dismissed with Esc (`nodeId:offset`): it stays closed. */
  private pickerDismissedFor: string | null = null;
  /** Candidates the picker currently shows, set by its view. */
  pickerItems: readonly TodayMentionTarget[] = [];
  private dropIndicator: TodayDropIndicator | null = null;
  private dragGhost: TodayDragGhost | null = null;
  private cancelSettle: (() => void) | null = null;
  private pointerSelecting = false;
  /** Workspace whose session links may be pasted into a node. */
  workspaceId: string | null = null;
  /** Plain-text form of a mention in copies and the Convert to task prompt (set by the host). */
  mentionText: TodayMentionText = (mention) => `@${mention.id}`;
  private pendingCaret: CaretTarget = 'end';
  private root: HTMLElement | null = null;
  private binding: { dispose(): void } | null = null;
  /**
   * The page last edited or selected: kept open while the surface uses it, and
   * the page undo/redo act on when no node or block is active (e.g. after a
   * selection deleted every node). `held` turns true once the asynchronous
   * acquire lands; a pin released before that releases on landing instead.
   */
  private pinned: { store: TodayPageStore; held: boolean; released: boolean } | null = null;
  private readonly days = new Map<TodayDate, TodayPageStore>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly cache: TodayPageStoreCache) {
    this.editor = createEditor({
      namespace: 'lody-today',
      nodes: [MentionDecoratorNode],
      onError: (error) => console.error('Today editor error', error),
    });
    this.cleanups.push(
      registerPlainText(this.editor),
      // Keep an editable caret target before every mention, as the composer does.
      this.editor.registerNodeTransform(MentionDecoratorNode, (node) => {
        $ensureMentionCaretTarget(node);
      }),
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
      // After the picker (same priority, registered later), before outline keys.
      this.editor.registerCommand(
        KEY_DOWN_COMMAND,
        (event) => this.onMentionKey(event),
        COMMAND_PRIORITY_CRITICAL
      ),
      this.editor.registerCommand(
        COPY_COMMAND,
        (event) => this.onEditorCopy(event, false),
        COMMAND_PRIORITY_HIGH
      ),
      this.editor.registerCommand(
        CUT_COMMAND,
        (event) => this.onEditorCopy(event, true),
        COMMAND_PRIORITY_HIGH
      ),
      this.editor.registerCommand(
        PASTE_COMMAND,
        (event) => this.onEditorPaste(event),
        COMMAND_PRIORITY_HIGH
      ),
      this.editor.registerUpdateListener(({ editorState }) => {
        const active = this.active;
        if (!active) return;
        // The `@` menu waits while an IME composes (e.g. a full-width ＠).
        const composing = this.editor.isComposing();
        const { offsets, trigger } = editorState.read(() => {
          const offsets = $readSelectionOffsets();
          const caret = offsets && offsets.start === offsets.end ? offsets.start : null;
          return {
            offsets,
            trigger:
              composing || caret === null
                ? null
                : findPickerTrigger($readComposerValue().text, caret),
          };
        });
        if (offsets) {
          active.store.undo.setSelection({
            nodeId: active.nodeId,
            anchor: offsets.start,
            focus: offsets.end,
          });
        }
        if (!trigger || this.pickerDismissedFor === `${active.nodeId}:${trigger.start}`) {
          this.closePicker();
          return;
        }
        const { query, start } = trigger;
        const same =
          this.picker?.nodeId === active.nodeId &&
          this.picker.start === start &&
          this.picker.query === query;
        if (same) return;
        this.picker = {
          store: active.store,
          nodeId: active.nodeId,
          query,
          index: 0,
          start,
          tab: this.picker?.tab ?? 'all',
        };
        this.notify();
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
    if (this.selection?.store !== store) return false;
    // Descendants of a selected row are acted on with it, so they show as selected.
    const rows = this.rowsOf(store);
    if (this.coveredFor?.snapshot !== rows || this.coveredFor.ids !== this.selection.ids) {
      this.coveredFor = {
        snapshot: rows,
        ids: this.selection.ids,
        covered: selectionCovers(rows, this.selection.ids),
      };
    }
    return this.coveredFor.covered.has(nodeId);
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
  getSurface() {
    return this.surface;
  }
  isSelectingByPointer() {
    return this.pointerSelecting;
  }
  getDropIndicator() {
    return this.dropIndicator;
  }
  getDragGhost() {
    return this.dragGhost;
  }

  // --- drag and drop ------------------------------------------------------
  private dayRows(store: TodayPageStore, day: Element) {
    const nodes = new Map(this.rowsOf(store).map((node) => [node.id, node] as const));
    const rows: TodayDropRow[] = [];
    let contentLeft = day.getBoundingClientRect().left;
    let right = day.getBoundingClientRect().right;
    const root = this.zoomRoot(store);
    for (const element of day.querySelectorAll<HTMLElement>('[data-today-node]')) {
      const node = nodes.get(element.dataset.todayNode as TodayNodeId);
      if (!node || node.id === root) continue;
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

  /**
   * Project a drop and place its line. `depthOrigin` is the x at which the
   * pointer means depth 0: for a node drag it follows the grab point, so a
   * purely vertical drag keeps the node's depth; otherwise it is the bullet
   * column. The line starts at the target depth's bullet, where the node lands.
   */
  private project(
    store: TodayPageStore,
    day: Element,
    point: { x: number; y: number },
    excluded: ReadonlySet<string>,
    depthOrigin?: number
  ): TodayDropTarget | null {
    const { rows, contentLeft, right } = this.dayRows(store, day);
    const origin = depthOrigin ?? contentLeft + TODAY_BULLET_CENTER_PX;
    const target = projectTodayDrop(rows, point, origin, TODAY_INDENT_PX, excluded);
    if (!target) {
      this.dropIndicator = null;
      return null;
    }
    const left = contentLeft + TODAY_BULLET_CENTER_PX + target.depth * TODAY_INDENT_PX;
    this.dropIndicator = {
      kind: 'line',
      top: target.lineTop,
      left,
      width: Math.max(right - left, 40),
    };
    return target;
  }

  /** Move nodes (or insert a node holding a mention) where a drop target points. */
  private dropAt(
    store: TodayPageStore,
    target: TodayDropTarget,
    ids: readonly TodayNodeId[] | null,
    sessionId?: string
  ) {
    const moving = new Set<string>(ids ?? []);
    const parentId = (target.parentId ?? this.zoomRoot(store)) as TodayNodeId | null;
    const siblings = store.outline.childIds(parentId).filter((id) => !moving.has(id));
    const index =
      target.after === null
        ? 0
        : target.after === 'end'
          ? siblings.length
          : siblings.indexOf(target.after as TodayNodeId) + 1;
    store.undo.structural(() => {
      if (target.expandParent && parentId) store.outline.setCollapsed(parentId, false);
      if (ids) store.outline.moveTo(ids, { parentId, index });
      else if (sessionId) {
        store.outline.insertMentionNode({ parentId, index }, { kind: 'session', id: sessionId });
      }
    });
  }

  /**
   * Bullet pressed: after 5px it drags the node (or the whole block selection
   * it belongs to) within its day; a press without movement zooms into the node.
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
    const ids = topLevelSelection(this.rowsOf(store), selection);
    const label = store.outline.getNode(ids[0]!)?.text ?? '';
    // Horizontal movement from the grab point changes depth, one indent per level.
    const depthOrigin =
      start.clientX - (store.outline.getNode(ids[0]!)?.depth ?? 0) * TODAY_INDENT_PX;
    let dragging = false;
    let target: TodayDropTarget | null = null;
    // A drop into a folded node unfolds it once the pointer rests there.
    let unfoldFor: string | null = null;
    let unfoldTimer: ReturnType<typeof setTimeout> | undefined;
    const aimUnfold = (parentId: string | null) => {
      if (parentId === unfoldFor) return;
      clearTimeout(unfoldTimer);
      unfoldFor = parentId;
      if (!parentId) return;
      unfoldTimer = setTimeout(() => {
        unfoldTimer = undefined;
        store.outline.setCollapsed(parentId as TodayNodeId, false);
      }, DRAG_UNFOLD_DELAY_MS);
    };
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
      clearTimeout(unfoldTimer);
      this.stopPointer = null;
      const wasDragging = dragging;
      const drop = commit ? target : null;
      const line = this.dropIndicator?.kind === 'line' ? this.dropIndicator : null;
      const ghost = this.dragGhost;
      this.dropIndicator = null;
      this.dragGhost = null;
      if (wasDragging && ghost) {
        // The card glides to the line it lands on, or flies back home.
        this.settleGhost(
          drop && line
            ? { ...ghost, x: line.left - 12, y: line.top - 8, settling: true }
            : { ...ghost, x: start.clientX, y: start.clientY, settling: true }
        );
      } else if (wasDragging) this.notify();
      if (drop) this.dropAt(store, drop, ids);
      if (commit && !wasDragging) {
        if (this.onZoom) this.onZoom(store, nodeId);
        else if (!this.isBlockSelected(store, nodeId)) this.selectBlocks(store, [nodeId]);
      }
    };
    const move = (event: PointerEvent) => {
      // The release happened where we could not see it (another window or app):
      // the drag is over, and a later click must not drop it.
      if ((event.buttons & 1) === 0) return finish(false);
      if (
        !dragging &&
        Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < DRAG_THRESHOLD_PX
      )
        return;
      if (!dragging) {
        dragging = true;
        this.cancelSettle?.();
        this.deactivate(false);
      }
      const rect = day.getBoundingClientRect();
      const inside = event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (inside) {
        target = this.project(
          store,
          day,
          { x: event.clientX, y: event.clientY },
          new Set(ids),
          depthOrigin
        );
      } else {
        target = null;
        this.dropIndicator = { kind: 'blocked', x: event.clientX, y: event.clientY };
      }
      aimUnfold(target?.expandParent ? target.parentId : null);
      this.dragGhost = { x: event.clientX, y: event.clientY, label, count: ids.length };
      this.notify();
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !dragging) return;
      // Esc only cancels the drag; it must not also enter block selection.
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    this.stopPointer = () => finish(false);
  }

  /** Show the released card gliding to `ghost`, then remove it. */
  private settleGhost(ghost: TodayDragGhost) {
    this.cancelSettle?.();
    this.dragGhost = ghost;
    this.notify();
    const timer = setTimeout(() => {
      this.cancelSettle = null;
      this.dragGhost = null;
      this.notify();
    }, DRAG_SETTLE_MS);
    this.cancelSettle = () => {
      clearTimeout(timer);
      this.cancelSettle = null;
      this.dragGhost = null;
    };
  }

  private closePicker() {
    if (!this.picker) return;
    this.picker = null;
    this.notify();
  }

  /** A conversation dragged from the sidebar hovers at (x, y). */
  hoverExternal(x: number, y: number): TodayDropTarget | null {
    const { target } = this.projectExternal(x, y);
    if (!target) this.dropIndicator = null;
    this.notify();
    return target;
  }

  leaveExternal() {
    if (!this.dropIndicator) return;
    this.dropIndicator = null;
    this.notify();
  }

  /** A conversation dropped from the sidebar: a new mention node at the line. */
  dropExternal(sessionId: string, x: number, y: number) {
    const { located, target } = this.projectExternal(x, y);
    this.dropIndicator = null;
    this.notify();
    if (located && target) this.dropAt(located.store, target, null, sessionId);
  }

  private projectExternal(x: number, y: number) {
    const located = this.dayAt(x, y);
    const target = located ? this.project(located.store, located.day, { x, y }, new Set()) : null;
    return { located, target };
  }

  private dayAt(x: number, y: number) {
    const stack =
      typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(x, y) : [];
    for (const element of stack) {
      const day = element.closest('[data-today-date]');
      const store = day && this.days.get(day.getAttribute('data-today-date') as TodayDate);
      if (day && store) return { day, store };
    }
    // Beside the readable column (the surface's gutters): the day at that height.
    if (!this.surface) return null;
    for (const day of this.surface.querySelectorAll('[data-today-date]')) {
      const rect = day.getBoundingClientRect();
      const store = this.days.get(day.getAttribute('data-today-date') as TodayDate);
      if (store && y >= rect.top && y <= rect.bottom) return { day, store };
    }
    return null;
  }

  private onPickerKey(event: KeyboardEvent): boolean {
    const picker = this.picker;
    if (!picker || isImeKey(event)) return false;
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
        const target = this.pickerItems[picker.index];
        if (!target) return false;
        event.preventDefault();
        queueMicrotask(() => this.acceptPicker(target));
        return true;
      }
      case 'Escape':
        this.pickerDismissedFor = `${picker.nodeId}:${picker.start}`;
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

  /** Replace the `@query` with a mention; one undo brings `@query` back. */
  acceptPicker(target: TodayMentionTarget) {
    const picker = this.picker;
    if (!picker) return;
    this.picker = null;
    const { store, nodeId, start, query } = picker;
    const focus = store.undo.structural(() =>
      store.outline.insertMention(nodeId, start, query.length + 1, target)
    );
    this.apply(store, focus);
  }

  setPickerTab(tab: TodayPickerTab) {
    if (!this.picker || this.picker.tab === tab) return;
    this.picker = { ...this.picker, tab, index: 0 };
    this.notify();
  }

  onOpenMember: ((userId: string) => void) | null = null;

  private readonly reveals = new Map<TodayPageStore, (nodeId: TodayNodeId) => void>();
  /** The focused day, or a node zoomed into: keys, selection and drops stay inside it. */
  private focus: { date: TodayDate; rootId: TodayNodeId | null } | null = null;
  private zoomRows: { from: object; rows: readonly TodayNodeView[] } | null = null;
  /** Zooms into a node: a bullet click or ⌥→ (wired by the host). */
  onZoom: ((store: TodayPageStore, nodeId: TodayNodeId) => void) | null = null;
  /** Leaves one level of focus: ⌥← (wired by the host). */
  onZoomOut: (() => void) | null = null;
  /** Opens a node's menu at its "⋯" button or the pointer (wired by the host). */
  onNodeMenu:
    | ((
        store: TodayPageStore,
        nodeId: TodayNodeId,
        anchor: HTMLElement | { x: number; y: number }
      ) => void)
    | null = null;

  setFocus(focus: { date: TodayDate; rootId: TodayNodeId | null } | null) {
    if (this.focus?.date === focus?.date && this.focus?.rootId === focus?.rootId) return;
    this.focus = focus;
    this.zoomRows = null;
    this.coveredFor = null;
    this.clearBlockSelection();
  }

  /** The node a day is zoomed into, if `store` is that day. */
  zoomRoot(store: TodayPageStore): TodayNodeId | null {
    return this.focus && this.focus.date === store.date ? this.focus.rootId : null;
  }

  /**
   * The rows keys and selection walk: the page's visible rows, or, zoomed in,
   * the zoomed node (depth -1) followed by its subtree.
   */
  rowsOf(store: TodayPageStore): readonly TodayNodeView[] {
    const root = this.zoomRoot(store);
    if (!root) return store.getSnapshot().visible;
    const subtree = store.outline.getSubtree(root);
    if (!subtree) return [];
    if (this.zoomRows?.from === subtree) return this.zoomRows.rows;
    const node = store.outline.getNode(root);
    const rows = node ? [{ ...node, depth: -1 }, ...subtree.visible] : [];
    this.zoomRows = { from: subtree, rows };
    return rows;
  }

  /** A virtualized page scrolls a row it has not mounted into view. */
  registerReveal(store: TodayPageStore, reveal: (nodeId: TodayNodeId) => void) {
    this.reveals.set(store, reveal);
    return () => {
      if (this.reveals.get(store) === reveal) this.reveals.delete(store);
    };
  }

  /** Sections register their open page so the caret can cross days. */
  registerDay(date: TodayDate, store: TodayPageStore) {
    this.days.set(date, store);
    this.notify();
    return () => {
      if (this.days.get(date) === store) this.days.delete(date);
    };
  }

  // --- activation ---------------------------------------------------------
  activate(store: TodayPageStore, nodeId: TodayNodeId, caret: CaretTarget) {
    if (!store.outline.getNode(nodeId)) return;
    this.selection = null;
    this.pendingCaret = caret;
    if (this.isActive(store, nodeId) && this.root) {
      this.placeCaret();
      return;
    }
    this.pin(store);
    this.active = { store, nodeId };
    if (!this.pickerDismissedFor?.startsWith(`${nodeId}:`)) this.pickerDismissedFor = null;
    this.notify();
  }

  selectBlocks(
    store: TodayPageStore,
    ids: TodayNodeId[],
    ends: { anchor?: TodayNodeId; focus?: TodayNodeId } = {}
  ) {
    if (ids.length === 0) return;
    this.textOrigin = null;
    this.deactivate(false);
    this.pin(store);
    this.selection = { store, ids };
    this.blockAnchor = ends.anchor ?? ids[0]!;
    this.blockFocus = ends.focus ?? ids.at(-1)!;
    store.undo.setSelection({ blockSelect: ids });
    window.getSelection()?.removeAllRanges();
    this.surface?.focus({ preventScroll: true });
    this.notify();
  }

  /** Scroll a row into view after the keyboard moves a block selection to it. */
  private revealRow(nodeId: TodayNodeId) {
    const row = this.surface?.querySelector<HTMLElement>(
      `[data-today-node="${CSS.escape(nodeId)}"]`
    );
    if (row) row.scrollIntoView?.({ block: 'nearest' });
    else if (this.selection) this.reveals.get(this.selection.store)?.(nodeId);
  }

  clearBlockSelection() {
    if (!this.selection) return;
    this.selection = null;
    this.notify();
  }

  /** The scroll surface: owns focus, keys and clipboard while blocks are selected. */
  attachSurface = (element: HTMLElement | null) => {
    this.surface?.removeEventListener('pointerdown', this.onSurfacePointerDown);
    this.surface = element;
    element?.addEventListener('pointerdown', this.onSurfacePointerDown);
  };

  /** Zoomed into a node without children, a press on the surface's empty area starts its first child. */
  private readonly onSurfacePointerDown = (event: PointerEvent) => {
    const surface = event.currentTarget as HTMLElement;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    if (!(event.target instanceof Element) || event.target.closest(SURFACE_CONTENT)) return;
    // The scroller's own scrollbar.
    const left = surface.getBoundingClientRect().left;
    if (
      event.target === surface &&
      event.clientX - left >= surface.clientLeft + surface.clientWidth
    )
      return;
    const root = this.focus?.rootId;
    const store = this.focus && this.days.get(this.focus.date);
    if (!root || !store?.outline.getNode(root) || store.outline.childIds(root).length) return;
    event.preventDefault();
    this.startPage(store, root);
  };

  /** Keys on the surface while blocks are selected. Returns true when handled. */
  onBlockKey(event: KeyboardEvent): boolean {
    const intent = resolveBlockKey(event, isMac() ? 'mac' : 'other');
    if (!intent) return false;
    // Undo works on the surface whether or not blocks are still selected (a
    // deleted selection leaves none, and an emptied page mounts no editor).
    if (intent.type === 'undo' || intent.type === 'redo') {
      if (!this.history(intent.type)) return false;
      event.preventDefault();
      return true;
    }
    const selection = this.selection;
    if (!selection) return false;
    event.preventDefault();
    const { store } = selection;
    const outline = store.outline;
    const visible = this.rowsOf(store);
    const zoomRoot = this.zoomRoot(store);
    const roots = topLevelSelection(visible, selection.ids).filter((id) => id !== zoomRoot);
    const keep = () =>
      this.selectBlocks(store, selection.ids, {
        anchor: this.blockAnchor ?? undefined,
        focus: this.blockFocus ?? undefined,
      });
    switch (intent.type) {
      case 'clear': {
        // A Shift+Up/Down selection returns to the text selection it came from.
        const origin = this.textOrigin;
        this.clearBlockSelection();
        if (origin && origin.store === store && store.outline.getNode(origin.nodeId)) {
          this.activate(store, origin.nodeId, { anchor: origin.anchor, focus: origin.focus });
        }
        return true;
      }
      case 'edit': {
        const node = visible.find((candidate) => candidate.id === this.blockFocus);
        if (!node) return true;
        this.activate(store, node.id, 'end');
        return true;
      }
      case 'delete':
        if (roots.length > 0) this.deleteBlocks(store, roots);
        return true;
      case 'step': {
        // Leave the range from its top (Up) or bottom (Down) edge.
        const range = blockRange(
          visible,
          this.blockAnchor ?? selection.ids[0]!,
          this.blockFocus ?? selection.ids.at(-1)!
        );
        const edge = intent.step < 0 ? range[0] : range.at(-1);
        const edgeIndex = visible.findIndex((node) => node.id === edge);
        let nextIndex = edgeIndex + intent.step;
        if (intent.step > 0) {
          const covered = selectionCovers(visible, range);
          while (nextIndex < visible.length && covered.has(visible[nextIndex]!.id)) nextIndex += 1;
        }
        const next = visible[nextIndex];
        if (next) {
          this.selectBlocks(store, [next.id]);
          this.revealRow(next.id);
        }
        return true;
      }
      case 'extend': {
        if (!this.blockAnchor || !this.blockFocus) return true;
        const anchor = this.blockAnchor;
        const next = extendFocus(visible, anchor, this.blockFocus, intent.step);
        if (!next) return true;
        const origin = this.textOrigin;
        this.selectBlocks(store, blockRange(visible, anchor, next), { anchor, focus: next });
        // Extending keeps the way back to the original text selection.
        this.textOrigin = origin;
        this.revealRow(next);
        return true;
      }
      case 'select-all': {
        if (zoomRoot && selection.ids.includes(zoomRoot)) return true;
        const next = escalateSelection(visible, selection.ids);
        if (next) this.selectBlocks(store, next);
        return true;
      }
      case 'zoom-in': {
        const target = this.blockFocus ?? selection.ids.at(-1);
        if (target && target !== zoomRoot) this.onZoom?.(store, target);
        return true;
      }
      case 'zoom-out':
        this.onZoomOut?.();
        return true;
      case 'cycle-todo':
        this.cycleSelectionTodo();
        return true;
      case 'indent':
      case 'outdent':
      case 'move-up':
      case 'move-down': {
        if (roots.length > 0) {
          store.undo.structural(() =>
            OUTLINE_MOVES[intent.type](outline, roots, zoomRoot ?? undefined)
          );
        }
        keep();
        return true;
      }
    }
  }

  /** Copy or cut the selected blocks (surface `copy`/`cut` events). */
  onBlockClipboard(event: ClipboardEvent, cut: boolean): boolean {
    const selection = this.selection;
    if (!selection || !event.clipboardData) return false;
    const { store } = selection;
    const roots = topLevelSelection(this.rowsOf(store), selection.ids);
    const fragments = store.outline.extract(roots);
    event.preventDefault();
    event.clipboardData.setData('text/plain', serializeTodayFragments(fragments, this.mentionText));
    event.clipboardData.setData(
      TODAY_CLIPBOARD_MIME,
      JSON.stringify({ v: TODAY_CLIPBOARD_VERSION, fragments })
    );
    if (cut) this.deleteBlocks(store, roots);
    return true;
  }

  cycleSelectionTodo() {
    const selection = this.selection;
    if (!selection) return;
    const { store, ids } = selection;
    store.undo.structural(() => store.outline.cycleTodo(ids));
  }

  toggleDone(store: TodayPageStore, nodeId: TodayNodeId) {
    const state = store.outline.getNode(nodeId)?.todo;
    if (!state) return;
    store.undo.structural(() =>
      store.outline.setTodo([nodeId], state === 'done' ? 'todo' : 'done')
    );
  }

  copySelection() {
    if (!this.selection || !this.surface) return;
    this.surface.focus({ preventScroll: true });
    this.surface.ownerDocument.execCommand('copy');
  }

  deleteSelection() {
    const selection = this.selection;
    if (!selection) return;
    const { store } = selection;
    this.deleteBlocks(store, topLevelSelection(this.rowsOf(store), selection.ids));
  }

  private deleteBlocks(store: TodayPageStore, roots: TodayNodeId[]) {
    this.clearBlockSelection();
    this.apply(
      store,
      store.undo.structural(() =>
        store.outline.deleteNodes(roots, { within: this.zoomRoot(store) ?? undefined })
      )
    );
  }

  /** Paste after the selected blocks. */
  onBlockPaste(event: ClipboardEvent): boolean {
    const selection = this.selection;
    const fragments = event.clipboardData && this.readPastedFragments(event.clipboardData);
    if (!selection || !fragments) return false;
    event.preventDefault();
    const { store } = selection;
    const roots = topLevelSelection(this.rowsOf(store), selection.ids);
    const after = roots.at(-1);
    if (!after) return true;
    this.apply(
      store,
      store.undo.structural(() => store.outline.paste({ kind: 'after', nodeId: after }, fragments))
    );
    return true;
  }

  /**
   * Clipboard blocks: our structured payload as is, or outline-parsed text
   * with this workspace's conversation links turned into mentions.
   */
  private readPastedFragments(data: DataTransfer): TodayFragment[] | null {
    const fragments = readClipboard(data);
    if (!fragments || data.getData(TODAY_CLIPBOARD_MIME)) return fragments;
    return linkifyTodayFragments(
      fragments,
      (link) => readPastedSessionLink(link, this.workspaceId)?.sessionId ?? null
    );
  }

  private onEditorPaste(event: ClipboardEvent | InputEvent | KeyboardEvent | null): boolean {
    const active = this.active;
    if (!active || !(event instanceof ClipboardEvent) || !event.clipboardData) return false;
    const data = event.clipboardData;
    const structured = data.getData(TODAY_CLIPBOARD_MIME);
    const text = data.getData('text/plain');
    const resolve = (link: string) =>
      readPastedSessionLink(link, this.workspaceId)?.sessionId ?? null;
    let fragments: TodayFragment[] | null;
    if (structured || text.includes('\n')) {
      fragments = this.readPastedFragments(data);
    } else {
      // One line: keep it verbatim, only turning conversation links into mentions.
      const rich = linkifyTodayText(text, resolve);
      if (rich.mentions.length === 0 && rich.text === text) return false;
      fragments = [{ ...rich, children: [] }];
    }
    if (!fragments) return false;
    event.preventDefault();
    const range = this.editor.getEditorState().read(() => $readSelectionOffsets());
    const offset = range?.start ?? 0;
    const { store, nodeId } = active;
    queueMicrotask(() =>
      this.apply(
        store,
        store.undo.structural(() => {
          // Pasting replaces the selection, in the same undo step.
          const selected = (range?.end ?? offset) - offset;
          if (selected > 0) store.outline.getText(nodeId)?.delete(offset, selected);
          return store.outline.paste({ kind: 'text', nodeId, offset }, fragments);
        })
      )
    );
    return true;
  }

  /** Opens a mention's status menu (wired by the host). */
  onMentionMenu: ((sessionId: string, anchor: HTMLElement) => void) | null = null;

  /** Opens a conversation (wired by the host). */
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
      const visible = this.rowsOf(store);
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

  /**
   * Pointer pressed inside the node being edited: the browser keeps the text
   * selection within the node, and dragging onto another row of the same day
   * turns it into a block selection, exactly as from a static row.
   */
  pointerDownInEditor(store: TodayPageStore, nodeId: TodayNodeId, element: HTMLElement) {
    this.trackDrag(store, nodeId, element.closest('[data-today-date]'));
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
    let last: TodayNodeId | null = null;
    const move = (event: PointerEvent) => {
      if ((event.buttons & 1) === 0) return stop();
      const target = rowAt(event.clientY);
      // Re-select only when the pointer crosses into another row.
      if (!target || target === last) return;
      last = target;
      if (target !== anchor) {
        const visible = this.rowsOf(store);
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
      this.pointerSelecting = false;
      if (this.selection) this.notify();
    };
    this.pointerSelecting = true;
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
    if (typeof caret === 'object' && 'anchor' in caret) {
      this.editor.update(
        () => $setSelectionOffsets(Math.min(caret.anchor, length), Math.min(caret.focus, length)),
        { discrete: true }
      );
      root?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
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

  /** Empty page placeholder clicked or typed into; with `parentId`, a zoomed node's "+". */
  startPage(store: TodayPageStore, parentId?: TodayNodeId) {
    const focus = store.undo.structural(() => store.outline.insertFirst('', parentId));
    this.apply(store, focus);
  }

  // --- keys ---------------------------------------------------------------
  /**
   * The selection as offsets. The browser moves the DOM caret before Lexical
   * hears `selectionchange` (e.g. Home then Backspace): read the live DOM
   * selection when it is ours.
   */
  private liveSelection(root: HTMLElement) {
    const dom = window.getSelection();
    return this.editor.read(() => {
      const length = $readComposerValue().text.length;
      if (dom?.anchorNode && dom.focusNode && root.contains(dom.anchorNode)) {
        const anchor = $domPointToOffset(this.editor, dom.anchorNode, dom.anchorOffset);
        const focus = $domPointToOffset(this.editor, dom.focusNode, dom.focusOffset);
        if (anchor !== null && focus !== null) return { anchor, focus, length };
      }
      const offsets = $readSelectionOffsets();
      return { anchor: offsets?.start ?? length, focus: offsets?.end ?? length, length };
    });
  }

  /** Two-step caret and deletion around mentions; Enter opens a selected one. */
  private onMentionKey(event: KeyboardEvent): boolean {
    const root = this.root;
    if (!this.active || !root || this.picker || !MENTION_KEYS.has(event.key)) return false;
    const state = this.liveSelection(root);
    const mentions = this.editor.read(() => $readTodayEditorRich().mentions);
    const intent = resolveMentionKey(
      event,
      state,
      mentions.map((mention) => mention.start)
    );
    if (!intent) return false;
    event.preventDefault();
    event.stopPropagation();
    // A selection set inside the key command does not reach the DOM selection;
    // apply it as its own update right after, as the outline intents do.
    const select = (anchor: number, focus: number) =>
      queueMicrotask(() =>
        this.editor.update(() => $setSelectionOffsets(anchor, focus), { discrete: true })
      );
    if (intent.type === 'select') select(intent.anchor, intent.focus);
    else if (intent.type === 'collapse') select(intent.offset, intent.offset);
    else {
      const mention = mentions.find((candidate) => candidate.start === intent.start);
      if (!mention || mention.kind !== 'session') return true;
      if (intent.type === 'open') {
        const modifiers = { metaKey: event.metaKey, ctrlKey: event.ctrlKey };
        queueMicrotask(() => this.onOpenSession?.(mention.id, modifiers));
      } else {
        const chip = root.querySelector<HTMLElement>(
          `[data-today-session="${CSS.escape(mention.id)}"] [data-today-mention-status]`
        );
        if (chip) queueMicrotask(() => this.onMentionMenu?.(mention.id, chip));
      }
    }
    return true;
  }

  /** Copy or cut inside a node: mentions become links in text, and stay mentions in Today. */
  private onEditorCopy(event: ClipboardEvent | KeyboardEvent | null, cut: boolean): boolean {
    if (!this.active || !(event instanceof ClipboardEvent) || !event.clipboardData) return false;
    const range = $readSelectionOffsets();
    if (!range || range.start === range.end) return false;
    const rich = sliceTodayRich($readTodayEditorRich(), range.start, range.end);
    event.preventDefault();
    event.clipboardData.setData('text/plain', todayRichToPlain(rich, this.mentionText));
    event.clipboardData.setData(
      TODAY_CLIPBOARD_MIME,
      JSON.stringify({ v: TODAY_CLIPBOARD_VERSION, fragments: [{ ...rich, children: [] }] })
    );
    if (cut) {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.removeText();
    }
    return true;
  }

  // --- keys (outline) -----------------------------------------------------
  private onKeyDown(event: KeyboardEvent): boolean {
    const active = this.active;
    const root = this.root;
    if (!active || !root) return false;
    const state = this.liveSelection(root);
    const offsets = {
      start: Math.min(state.anchor, state.focus),
      end: Math.max(state.anchor, state.focus),
    };
    // Line edges are measured at the selection's moving end (its focus).
    const lines = caretEdgeLines(root);
    const intent = resolveOutlineKey(
      event,
      {
        offset: offsets.start,
        anchor: state.anchor,
        focus: state.focus,
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
    queueMicrotask(() => {
      // Another node (or none) became active before this ran: the key no
      // longer belongs to it.
      const current = this.active;
      if (current?.store !== active.store || current.nodeId !== active.nodeId) return;
      if (intent.type === 'select-from-text' && active.nodeId !== this.zoomRoot(active.store)) {
        // Remember the text selection so Esc can return to it.
        const origin = {
          store: active.store,
          nodeId: active.nodeId,
          anchor: state.anchor,
          focus: state.focus,
        };
        this.selectBlocks(active.store, [active.nodeId]);
        this.textOrigin = origin;
        return;
      }
      this.run(active, intent, offsets.start, goalX, offsets.end);
    });
    return true;
  }

  private run(
    active: TodayActiveNode,
    intent: OutlineIntent,
    offset: number,
    goalX: number,
    end = offset
  ) {
    const { store, nodeId } = active;
    const outline = store.outline;
    const keepCaret = () => this.activate(store, nodeId, offset);
    const root = this.zoomRoot(store);
    if (root && nodeId === root) {
      if (intent.type === 'split' || intent.type === 'enter-empty') {
        return this.apply(
          store,
          store.undo.structural(() => {
            if (end > offset) outline.getText(nodeId)?.delete(offset, end - offset);
            return outline.split(nodeId, offset, { intoChildren: true });
          })
        );
      }
      if (
        intent.type === 'merge-previous' ||
        intent.type === 'indent' ||
        intent.type === 'outdent' ||
        intent.type === 'move-up' ||
        intent.type === 'move-down' ||
        intent.type === 'block-select' ||
        intent.type === 'select-from-text'
      ) {
        return keepCaret();
      }
    }
    switch (intent.type) {
      case 'zoom-in':
        return this.onZoom?.(store, nodeId);
      case 'zoom-out':
        return this.onZoomOut?.();
      case 'split':
        // Enter over a selection replaces it, as typing would: one undo step.
        return this.apply(
          store,
          store.undo.structural(() => {
            if (end > offset) outline.getText(nodeId)?.delete(offset, end - offset);
            return outline.split(nodeId, offset);
          })
        );
      case 'enter-empty':
        return this.apply(
          store,
          store.undo.structural(() => outline.enterOnEmpty(nodeId, { within: root ?? undefined }))
        );
      case 'merge-previous':
        return this.apply(
          store,
          store.undo.structural(() =>
            outline.mergeWithPrevious(nodeId, { within: root ?? undefined })
          )
        );
      case 'merge-next':
        return this.apply(
          store,
          store.undo.structural(() => outline.mergeWithNext(nodeId, { within: root ?? undefined }))
        );
      case 'indent':
      case 'outdent':
      case 'move-up':
      case 'move-down':
        store.undo.structural(() =>
          OUTLINE_MOVES[intent.type](outline, [nodeId], root ?? undefined)
        );
        return keepCaret();
      case 'collapse':
      case 'expand':
        // Folding is not an undo step.
        outline.setCollapsed(nodeId, intent.type === 'collapse');
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
      case 'cycle-todo':
        store.undo.structural(() => outline.cycleTodo([nodeId]));
        return keepCaret();
      case 'extend-text':
        this.editor.update(() => $setSelectionOffsets(intent.anchor, intent.focus), {
          discrete: true,
        });
        return;
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
    const visible = this.rowsOf(store);
    const index = visible.findIndex((node) => node.id === nodeId);
    const inPage = index < 0 ? undefined : visible[index + step];
    if (inPage) return this.activate(store, inPage.id, caret);
    if (this.focus) return;
    const ordered = [...this.days.entries()].sort(([a], [b]) => (a < b ? 1 : -1));
    const dayIndex = ordered.findIndex(([, page]) => page === store);
    for (let next = dayIndex + step; next >= 0 && next < ordered.length; next += step) {
      const page = ordered[next]![1];
      const nodes = page.getSnapshot().visible;
      const target = step === 1 ? nodes[0] : nodes.at(-1);
      if (target) return this.activate(page, target.id, caret);
    }
  }

  private history(direction: 'undo' | 'redo'): boolean {
    const store = this.active?.store ?? this.selection?.store ?? this.pinned?.store;
    if (!store) return false;
    queueMicrotask(() => {
      const stop = store.undo.onRestore((intent) => this.apply(store, intent));
      if (direction === 'undo') store.undo.undo();
      else store.undo.redo();
      stop();
    });
    return true;
  }

  private pin(store: TodayPageStore) {
    if (this.pinned?.store.docId === store.docId) return;
    const previous = this.pinned;
    const entry = { store, held: false, released: false };
    this.pinned = entry;
    this.cache.acquire(store.docId).then(
      () => {
        if (entry.released) this.cache.releaseRef(store.docId);
        else entry.held = true;
      },
      (error: unknown) => console.warn('Today editor could not hold its page', error)
    );
    if (previous) this.unpin(previous);
  }

  private unpin(entry: { store: TodayPageStore; held: boolean; released: boolean }) {
    entry.released = true;
    if (entry.held) this.cache.releaseRef(entry.store.docId);
  }

  dispose() {
    this.stopPointer?.();
    this.cancelSettle?.();
    this.deactivate(false);
    if (this.pinned) this.unpin(this.pinned);
    this.pinned = null;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.listeners.clear();
    this.attachSurface(null);
  }
}

function readClipboard(data: DataTransfer) {
  return parseTodayClipboard({
    json: data.getData(TODAY_CLIPBOARD_MIME) || undefined,
    text: data.getData('text/plain') || undefined,
  });
}
