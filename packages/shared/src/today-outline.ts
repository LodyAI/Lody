import {
  LoroText,
  UndoManager,
  type Cursor,
  type LoroDoc,
  type LoroTree,
  type LoroTreeNode,
  type TreeID,
} from 'loro-crdt';

/**
 * Today outline page model over one LoroDoc.
 * Behavior: specs/today-outline.md (Outline editing, Data ownership).
 *
 * Structure lives in the `outline` LoroTree; each node's data map holds a
 * `text` LoroText created in the same commit as the node, an optional
 * `sessionId` (session node) and `collapsed: true` when folded. Unknown root
 * containers and data keys are ignored. Every structural operation validates
 * first, then mutates and commits once, because a Loro transaction cannot be
 * rolled back after a partial failure.
 */
export const TODAY_OUTLINE_TREE = 'outline';
export const TODAY_OUTLINE_EDIT_ORIGIN = 'today:edit';
/** Fractional-index jitter: fewer rearranges when peers insert at the same spot. */
const TODAY_FRACTIONAL_INDEX_JITTER = 4;

export type TodayNodeId = TreeID;

export type TodayNodeView = {
  id: TodayNodeId;
  parentId: TodayNodeId | null;
  depth: number;
  kind: 'text' | 'session';
  text: string;
  sessionId?: string;
  collapsed: boolean;
  hasChildren: boolean;
};

export type TodayPageSnapshot = {
  /** Nodes in document order, excluding children of folded nodes. */
  visible: readonly TodayNodeView[];
  /** No node has text or a session reference. */
  isEmpty: boolean;
};

export type TodayFragment = {
  text: string;
  sessionId?: string;
  collapsed?: boolean;
  children: TodayFragment[];
};

export type FocusIntent =
  | { nodeId: TodayNodeId; offset: number | 'end' }
  | { blockSelect: TodayNodeId[] }
  | null;

export type TodayPastePosition =
  | { kind: 'page-start' }
  | { kind: 'page-end' }
  | { kind: 'after'; nodeId: TodayNodeId }
  | { kind: 'text'; nodeId: TodayNodeId; offset: number };

export type TodayMoveTarget = { parentId: TodayNodeId | null; index: number };

export type TodayOutline = {
  getAllNodes(): TodayNodeView[];
  getSnapshot(): TodayPageSnapshot;
  getNode(id: TodayNodeId): TodayNodeView | undefined;
  getText(id: TodayNodeId): LoroText | undefined;
  insertFirst(text?: string): FocusIntent;
  split(id: TodayNodeId, offset: number): FocusIntent;
  enterOnEmpty(id: TodayNodeId): FocusIntent;
  mergeWithPrevious(id: TodayNodeId): FocusIntent;
  mergeWithNext(id: TodayNodeId): FocusIntent;
  indent(ids: readonly TodayNodeId[]): boolean;
  outdent(ids: readonly TodayNodeId[]): boolean;
  moveUp(ids: readonly TodayNodeId[]): boolean;
  moveDown(ids: readonly TodayNodeId[]): boolean;
  moveTo(ids: readonly TodayNodeId[], target: TodayMoveTarget): boolean;
  setCollapsed(id: TodayNodeId, collapsed: boolean): void;
  deleteNodes(ids: readonly TodayNodeId[]): FocusIntent;
  convertToSession(
    id: TodayNodeId,
    sessionId: string,
    options?: { collapseChildren?: boolean }
  ): boolean;
  insertSessionNode(target: TodayMoveTarget, sessionId: string): FocusIntent;
  extract(ids: readonly TodayNodeId[]): TodayFragment[];
  paste(position: TodayPastePosition, fragments: readonly TodayFragment[]): FocusIntent;
};

type Node = LoroTreeNode;

export function openTodayOutline(doc: LoroDoc, options: { origin?: string } = {}): TodayOutline {
  const origin = options.origin ?? TODAY_OUTLINE_EDIT_ORIGIN;
  const tree: LoroTree = doc.getTree(TODAY_OUTLINE_TREE);
  tree.enableFractionalIndex(TODAY_FRACTIONAL_INDEX_JITTER);

  const commit = () => doc.commit({ origin });
  const live = (id: TodayNodeId): Node | undefined => {
    const node = tree.getNodeByID(id);
    return node && !node.isDeleted() ? node : undefined;
  };
  const textOf = (node: Node): LoroText | undefined => {
    const value = node.data.get('text');
    return value instanceof LoroText ? value : undefined;
  };
  const readText = (node: Node) => textOf(node)?.toString() ?? '';
  const sessionOf = (node: Node): string | undefined => {
    const value = node.data.get('sessionId');
    return typeof value === 'string' && value ? value : undefined;
  };
  const isCollapsed = (node: Node) => node.data.get('collapsed') === true;
  const childrenOf = (parent: Node | undefined): Node[] =>
    parent ? (parent.children() ?? []) : tree.roots();
  const siblingsOf = (node: Node) => childrenOf(node.parent());
  const indexOf = (node: Node) => node.index() ?? 0;

  const view = (node: Node, depth: number): TodayNodeView => {
    const sessionId = sessionOf(node);
    return {
      id: node.id,
      parentId: node.parent()?.id ?? null,
      depth,
      kind: sessionId ? 'session' : 'text',
      text: readText(node),
      ...(sessionId ? { sessionId } : {}),
      collapsed: isCollapsed(node),
      hasChildren: childrenOf(node).length > 0,
    };
  };

  const walk = (onlyVisible: boolean): TodayNodeView[] => {
    const out: TodayNodeView[] = [];
    const visit = (nodes: Node[], depth: number) => {
      for (const node of nodes) {
        out.push(view(node, depth));
        if (onlyVisible && isCollapsed(node)) continue;
        visit(childrenOf(node), depth + 1);
      }
    };
    visit(tree.roots(), 0);
    return out;
  };

  const depthOf = (node: Node) => {
    let depth = 0;
    for (let parent = node.parent(); parent; parent = parent.parent()) depth += 1;
    return depth;
  };

  /** Create a node and its text in the caller's pending commit. */
  const create = (
    parent: Node | undefined,
    index: number | undefined,
    content: { text?: string; sessionId?: string; collapsed?: boolean }
  ): Node => {
    const node = parent ? parent.createNode(index) : tree.createNode(undefined, index);
    const text = node.data.setContainer('text', new LoroText());
    if (content.text) text.insert(0, content.text);
    if (content.sessionId) node.data.set('sessionId', content.sessionId);
    if (content.collapsed) node.data.set('collapsed', true);
    return node;
  };

  const createFragment = (
    parent: Node | undefined,
    index: number | undefined,
    fragment: TodayFragment
  ): Node => {
    const node = create(parent, index, fragment);
    for (const child of fragment.children) createFragment(node, undefined, child);
    return node;
  };

  const appendChildrenOf = (from: Node, to: Node) => {
    for (const child of childrenOf(from)) child.move(to);
  };

  const visibleNeighbour = (id: TodayNodeId, step: -1 | 1): TodayNodeView | undefined => {
    const visible = walk(true);
    const index = visible.findIndex((node) => node.id === id);
    return index < 0 ? undefined : visible[index + step];
  };

  /** True when `candidate` is `ancestorId` or lies inside its subtree. */
  const isWithin = (candidate: Node | undefined, ancestorId: TodayNodeId) => {
    for (let node = candidate; node; node = node.parent()) {
      if (node.id === ancestorId) return true;
    }
    return false;
  };

  const liveAll = (ids: readonly TodayNodeId[]): Node[] | undefined => {
    const nodes = ids.map(live);
    return nodes.every((node): node is Node => node !== undefined) && nodes.length > 0
      ? nodes
      : undefined;
  };

  const toFragment = (node: Node): TodayFragment => {
    const sessionId = sessionOf(node);
    return {
      text: readText(node),
      ...(sessionId ? { sessionId } : {}),
      ...(isCollapsed(node) ? { collapsed: true } : {}),
      children: childrenOf(node).map(toFragment),
    };
  };

  const outline: TodayOutline = {
    getAllNodes: () => walk(false),
    getSnapshot: () => {
      const all = walk(false);
      return {
        visible: walk(true),
        isEmpty: !all.some((node) => node.sessionId || node.text.trim()),
      };
    },
    getNode: (id) => {
      const node = live(id);
      return node ? view(node, depthOf(node)) : undefined;
    },
    getText: (id) => {
      const node = live(id);
      return node ? textOf(node) : undefined;
    },

    insertFirst: (text = '') => {
      const node = create(undefined, tree.roots().length, { text });
      commit();
      return { nodeId: node.id, offset: text.length };
    },

    split: (id, offset) => {
      const node = live(id);
      const text = node && textOf(node);
      if (!node || !text) return null;
      const length = text.length;
      if (offset <= 0 && length > 0) {
        create(node.parent(), indexOf(node), {});
        commit();
        return { nodeId: id, offset: 0 };
      }
      const right = text.toString().slice(offset);
      if (right) text.delete(offset, length - offset);
      const intoChildren = childrenOf(node).length > 0 && !isCollapsed(node);
      const created = intoChildren
        ? create(node, 0, { text: right })
        : create(node.parent(), indexOf(node) + 1, { text: right });
      commit();
      return { nodeId: created.id, offset: 0 };
    },

    enterOnEmpty: (id) => {
      const node = live(id);
      if (!node) return null;
      const parent = node.parent();
      const siblings = siblingsOf(node);
      if (parent && siblings.at(-1)?.id === node.id) {
        node.moveAfter(parent);
        commit();
        return { nodeId: id, offset: 0 };
      }
      const created = create(parent, indexOf(node) + 1, {});
      commit();
      return { nodeId: created.id, offset: 0 };
    },

    mergeWithPrevious: (id) => {
      const node = live(id);
      const previousView = visibleNeighbour(id, -1);
      const previous = previousView && live(previousView.id);
      if (!node || !previous) return null;
      if (sessionOf(previous)) return { blockSelect: [previous.id] };
      const previousText = textOf(previous);
      if (!previousText) return null;
      if (!previousText.length && childrenOf(previous).length === 0) {
        tree.delete(previous.id);
        commit();
        return { nodeId: id, offset: 0 };
      }
      const offset = previousText.length;
      const moved = readText(node);
      if (moved) previousText.insert(offset, moved);
      if (isWithin(node, previous.id)) {
        // Merging a first child into its parent: its children take its place.
        for (const child of childrenOf(node)) child.moveBefore(node);
      } else {
        appendChildrenOf(node, previous);
      }
      tree.delete(node.id);
      commit();
      return { nodeId: previous.id, offset };
    },

    mergeWithNext: (id) => {
      const node = live(id);
      const text = node && textOf(node);
      if (!node || !text) return null;
      if (isCollapsed(node) && childrenOf(node).length > 0) return null;
      const nextView = visibleNeighbour(id, 1);
      const next = nextView && live(nextView.id);
      if (!next) return null;
      if (sessionOf(next)) return { blockSelect: [next.id] };
      const offset = text.length;
      const moved = readText(next);
      if (moved) text.insert(offset, moved);
      if (next.parent()?.id === node.id) {
        for (const child of childrenOf(next)) child.moveBefore(next);
      } else {
        appendChildrenOf(next, node);
      }
      tree.delete(next.id);
      commit();
      return { nodeId: id, offset };
    },

    indent: (ids) => {
      const nodes = liveAll(ids);
      if (!nodes) return false;
      const first = nodes[0]!;
      const index = indexOf(first);
      if (index === 0) return false;
      const target = siblingsOf(first)[index - 1];
      if (!target) return false;
      if (isCollapsed(target)) target.data.delete('collapsed');
      for (const node of nodes) node.move(target);
      commit();
      return true;
    },

    outdent: (ids) => {
      const nodes = liveAll(ids);
      if (!nodes) return false;
      const parent = nodes[0]!.parent();
      if (!parent) return false;
      const last = nodes.at(-1)!;
      const followers = siblingsOf(last).slice(indexOf(last) + 1);
      let anchor = parent;
      for (const node of nodes) {
        node.moveAfter(anchor);
        anchor = node;
      }
      for (const follower of followers) follower.move(last);
      commit();
      return true;
    },

    moveUp: (ids) => {
      const nodes = liveAll(ids);
      if (!nodes) return false;
      const first = nodes[0]!;
      const previous = siblingsOf(first)[indexOf(first) - 1];
      if (!previous) return false;
      previous.moveAfter(nodes.at(-1)!);
      commit();
      return true;
    },

    moveDown: (ids) => {
      const nodes = liveAll(ids);
      if (!nodes) return false;
      const last = nodes.at(-1)!;
      const next = siblingsOf(last)[indexOf(last) + 1];
      if (!next) return false;
      next.moveBefore(nodes[0]!);
      commit();
      return true;
    },

    moveTo: (ids, target) => {
      const nodes = liveAll(ids);
      if (!nodes) return false;
      const parent = target.parentId === null ? undefined : live(target.parentId);
      if (target.parentId !== null && !parent) return false;
      if (nodes.some((node) => isWithin(parent, node.id))) return false;
      const moving = new Set(ids);
      const siblings = childrenOf(parent).filter((node) => !moving.has(node.id));
      const before = siblings[target.index];
      for (const node of nodes) {
        if (before) node.moveBefore(before);
        else node.move(parent);
      }
      commit();
      return true;
    },

    setCollapsed: (id, collapsed) => {
      const node = live(id);
      if (!node || isCollapsed(node) === collapsed) return;
      if (collapsed) node.data.set('collapsed', true);
      else node.data.delete('collapsed');
      commit();
    },

    deleteNodes: (ids) => {
      const nodes = liveAll(ids);
      if (!nodes) return null;
      const removed = new Set(ids);
      const visible = walk(true);
      const firstIndex = visible.findIndex((node) => removed.has(node.id));
      const isRemoved = (candidate: TodayNodeView) =>
        nodes.some((node) => isWithin(live(candidate.id), node.id));
      const survivor =
        visible
          .slice(0, Math.max(firstIndex, 0))
          .reverse()
          .find((candidate) => !isRemoved(candidate)) ??
        visible.slice(firstIndex + 1).find((candidate) => !isRemoved(candidate));
      for (const node of nodes) {
        if (!nodes.some((other) => other !== node && isWithin(node.parent(), other.id))) {
          tree.delete(node.id);
        }
      }
      commit();
      return survivor ? { nodeId: survivor.id, offset: 'end' } : null;
    },

    convertToSession: (id, sessionId, options = {}) => {
      const node = live(id);
      if (!node) return false;
      node.data.set('sessionId', sessionId);
      if (options.collapseChildren && childrenOf(node).length > 0) {
        node.data.set('collapsed', true);
      }
      commit();
      return true;
    },

    insertSessionNode: (target, sessionId) => {
      const parent = target.parentId === null ? undefined : live(target.parentId);
      if (target.parentId !== null && !parent) return null;
      const index = Math.min(target.index, childrenOf(parent).length);
      const node = create(parent, index, { sessionId });
      commit();
      return { blockSelect: [node.id] };
    },

    extract: (ids) => {
      const nodes = liveAll(ids);
      return nodes ? nodes.map(toFragment) : [];
    },

    paste: (position, fragments) => {
      if (fragments.length === 0) return null;
      const insertAll = (parent: Node | undefined, start: number) => {
        let last: Node | undefined;
        fragments.forEach((fragment, offset) => {
          last = createFragment(parent, start + offset, fragment);
        });
        commit();
        return last ? { nodeId: last.id, offset: 'end' as const } : null;
      };

      if (position.kind === 'page-start') return insertAll(undefined, 0);
      if (position.kind === 'page-end') return insertAll(undefined, tree.roots().length);
      const node = live(position.nodeId);
      if (!node) return null;
      if (position.kind === 'after') return insertAll(node.parent(), indexOf(node) + 1);

      const text = textOf(node);
      if (!text) return null;
      const [head, ...rest] = fragments as [TodayFragment, ...TodayFragment[]];
      const offset = Math.min(Math.max(position.offset, 0), text.length);

      if (fragments.length === 1 && head.children.length === 0 && !head.sessionId) {
        if (head.text) text.insert(offset, head.text);
        commit();
        return { nodeId: node.id, offset: offset + head.text.length };
      }
      if (sessionOf(node) || head.sessionId) {
        return insertAll(node.parent(), indexOf(node) + 1);
      }

      const tail = text.toString().slice(offset);
      if (tail) text.delete(offset, tail.length);
      if (head.text) text.insert(offset, head.text);
      head.children.forEach((child, index) => createFragment(node, index, child));
      let lastNode = node;
      let lastText = text;
      rest.forEach((fragment, index) => {
        lastNode = createFragment(node.parent(), indexOf(node) + 1 + index, fragment);
        lastText = textOf(lastNode)!;
      });
      const caret = lastText.length;
      if (tail) lastText.insert(caret, tail);
      commit();
      return { nodeId: lastNode.id, offset: caret };
    },
  };
  return outline;
}

const FENCE_PATTERN = /^(```|~~~)/;
const BULLET_PATTERN = /^[-*+•]\s+/;

function indentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 2;
    else break;
  }
  return width;
}

/**
 * Split pasted text into outline fragments: one node per non-blank line,
 * hierarchy inferred from relative indentation, list bullets removed, and a
 * fenced code block kept as one multi-line node.
 */
export function parseTodayPasteText(input: string): TodayFragment[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const roots: TodayFragment[] = [];
  const stack: { indent: number; fragment: TodayFragment }[] = [];
  const place = (indent: number, text: string) => {
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const fragment: TodayFragment = { text, children: [] };
    (stack.at(-1)?.fragment.children ?? roots).push(fragment);
    stack.push({ indent, fragment });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = indentWidth(line);
    const fence = FENCE_PATTERN.exec(trimmed)?.[1];
    if (fence) {
      const block = [trimmed];
      let end = index + 1;
      while (end < lines.length && !lines[end]!.trim().startsWith(fence)) {
        block.push(lines[end]!.slice(Math.min(indent, indentWidth(lines[end]!))));
        end += 1;
      }
      if (end < lines.length) block.push(lines[end]!.trim());
      place(indent, block.join('\n'));
      index = end;
      continue;
    }
    place(indent, trimmed.replace(BULLET_PATTERN, ''));
  }
  return roots;
}

export type TodaySelection =
  | { nodeId: TodayNodeId; anchor: number; focus: number }
  | { blockSelect: TodayNodeId[] }
  | null;

export type TodayPageUndo = {
  /** Record the selection the next undo step should restore. */
  setSelection(selection: TodaySelection): void;
  /** Apply a typing edit; consecutive edits to one node share an undo step until idle. */
  editText(text: LoroText, apply: (text: LoroText) => void): void;
  /** Run a structural operation as its own undo step. */
  structural<T>(operation: () => T): T;
  endGroup(): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
  onRestore(listener: (intent: FocusIntent) => void): () => void;
  dispose(): void;
};

/** Idle gap that closes a typing group. */
export const TODAY_TYPING_GROUP_IDLE_MS = 1000;

/**
 * Per-page undo. Loro's merge interval is 0 because, in loro-crdt 1.17, a
 * merge interval also merges across groups (typing followed by Enter would
 * become one step); typing groups are managed here instead, closed by an idle
 * timer, a node switch, a structural operation, or an undo/redo. Commits whose
 * origin starts with `sys:` are never undone.
 */
export function createTodayPageUndo(
  doc: LoroDoc,
  options: {
    setTimer: (callback: () => void, ms: number) => () => void;
    origin?: string;
    idleMs?: number;
  }
): TodayPageUndo {
  const origin = options.origin ?? TODAY_OUTLINE_EDIT_ORIGIN;
  const listeners = new Set<(intent: FocusIntent) => void>();
  let selection: TodaySelection = null;
  let groupText: LoroText | undefined;
  let cancelIdle: (() => void) | undefined;

  const manager = new UndoManager(doc, {
    mergeInterval: 0,
    maxUndoSteps: 100,
    excludeOriginPrefixes: ['sys:'],
    onPush: () => {
      if (!selection) return { value: null, cursors: [] };
      if ('blockSelect' in selection) {
        return { value: { blockSelect: selection.blockSelect }, cursors: [] };
      }
      const text = doc.getTree(TODAY_OUTLINE_TREE).getNodeByID(selection.nodeId)?.data.get('text');
      const cursor = text instanceof LoroText ? text.getCursor(selection.focus) : undefined;
      return { value: { nodeId: selection.nodeId }, cursors: cursor ? [cursor] : [] };
    },
    onPop: (_isUndo, { value, cursors }) => {
      const intent = restoredIntent(value, cursors);
      for (const listener of listeners) listener(intent);
    },
  });

  const restoredIntent = (value: unknown, cursors: Cursor[]): FocusIntent => {
    if (!value || typeof value !== 'object') return null;
    if ('blockSelect' in value && Array.isArray(value.blockSelect)) {
      return { blockSelect: value.blockSelect as TodayNodeId[] };
    }
    if (!('nodeId' in value) || typeof value.nodeId !== 'string') return null;
    const cursor = cursors[0];
    const offset = cursor ? doc.getCursorPos(cursor)?.offset : undefined;
    return { nodeId: value.nodeId as TodayNodeId, offset: offset ?? 'end' };
  };

  const endGroup = () => {
    cancelIdle?.();
    cancelIdle = undefined;
    if (!groupText) return;
    groupText = undefined;
    manager.groupEnd();
  };

  return {
    setSelection: (next) => {
      selection = next;
    },
    editText: (text, apply) => {
      if (groupText && groupText.id !== text.id) endGroup();
      if (!groupText) {
        manager.groupStart();
        groupText = text;
      }
      apply(text);
      doc.commit({ origin });
      cancelIdle?.();
      cancelIdle = options.setTimer(endGroup, options.idleMs ?? TODAY_TYPING_GROUP_IDLE_MS);
    },
    structural: (operation) => {
      endGroup();
      return operation();
    },
    endGroup,
    undo: () => {
      endGroup();
      return manager.undo();
    },
    redo: () => {
      endGroup();
      return manager.redo();
    },
    canUndo: () => manager.canUndo(),
    canRedo: () => manager.canRedo(),
    clear: () => {
      endGroup();
      manager.clear();
    },
    onRestore: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      endGroup();
      listeners.clear();
      manager.free();
    },
  };
}
