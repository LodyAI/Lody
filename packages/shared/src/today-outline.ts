import {
  LoroText,
  UndoManager,
  type Cursor,
  type Delta,
  type LoroDoc,
  type LoroTree,
  type LoroTreeNode,
  type TreeID,
} from 'loro-crdt';

/**
 * Today outline page model over one LoroDoc.
 * Behavior: specs/today-outline.md (Outline editing, Conversation mentions,
 * Data ownership).
 *
 * Structure lives in the `outline` LoroTree; each node's data map holds a
 * `text` LoroText created in the same commit as the node and `collapsed: true`
 * when folded (`todo` holds a to-do's state). A conversation mention is one U+FFFC character of that text
 * carrying the `mention = {kind, id}` mark (expand `none`). Unknown root
 * containers and data keys are ignored. Every structural operation validates
 * first, then mutates and commits once, because a Loro transaction cannot be
 * rolled back after a partial failure.
 */
export const TODAY_OUTLINE_TREE = 'outline';
export const TODAY_OUTLINE_EDIT_ORIGIN = 'today:edit';
/** Fold toggles: synced with the page but never undo steps. */
export const TODAY_OUTLINE_FOLD_ORIGIN = 'sys:today-fold';
/** Fractional-index jitter: fewer rearranges when peers insert at the same spot. */
const TODAY_FRACTIONAL_INDEX_JITTER = 4;

/** The one character a mention occupies in node text. */
export const TODAY_MENTION_CHAR = '\uFFFC';
/** The LoroText mark key carrying a mention's `{kind, id}`. */
export const TODAY_MENTION_MARK = 'mention';

/**
 * A mention at `start` (always one character long). `kind: ''` is a bare
 * U+FFFC without a mark: shown as a placeholder, never written back as a mark.
 */
export type TodayMention = { start: number; kind: string; id: string };
export type TodayMentionTarget = { kind: string; id: string };
/** Node text and the mentions inside it, ordered by `start`. */
export type TodayRichText = { text: string; mentions: TodayMention[] };

export type TodayNodeId = TreeID;

export type TodayTodoState = 'todo' | 'done';
const TODO_STATES: readonly unknown[] = ['todo', 'done'];
export const isTodayTodoState = (value: unknown): value is TodayTodoState =>
  TODO_STATES.includes(value);
export const nextTodayTodoState = (
  state: TodayTodoState | undefined
): TodayTodoState | undefined =>
  state === undefined ? 'todo' : state === 'todo' ? 'done' : undefined;

export type TodayNodeView = {
  id: TodayNodeId;
  parentId: TodayNodeId | null;
  depth: number;
  text: string;
  mentions: readonly TodayMention[];
  collapsed: boolean;
  hasChildren: boolean;
  todo?: TodayTodoState;
};

export type TodayPageSnapshot = {
  /** Nodes in document order, excluding children of folded nodes. */
  visible: readonly TodayNodeView[];
  /** No node has text (a mention counts as text). */
  isEmpty: boolean;
  /**
   * Replaced whenever the visible rows' order or nesting may have changed;
   * the same object while only their text changed.
   */
  layout: object;
};

export type TodayFragment = {
  text: string;
  mentions?: TodayMention[];
  collapsed?: boolean;
  todo?: TodayTodoState;
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
  /** Child ids of `parentId` (the roots for null), in order; hidden ones included. */
  childIds(parentId: TodayNodeId | null): TodayNodeId[];
  getSnapshot(): TodayPageSnapshot;
  /**
   * The rows under `rootId` for a zoomed view: its descendants, depth counted
   * from its children (0), shown even when the root itself is folded. Null
   * when the node is gone.
   */
  getSubtree(rootId: TodayNodeId): TodayPageSnapshot | null;
  getNode(id: TodayNodeId): TodayNodeView | undefined;
  getText(id: TodayNodeId): LoroText | undefined;
  /** The first line of an empty page, or with `parentId` the first child of that node. */
  insertFirst(text?: string, parentId?: TodayNodeId): FocusIntent;
  /** `intoChildren`: the new line becomes the first child (a zoomed root's title). */
  split(id: TodayNodeId, offset: number, options?: { intoChildren?: boolean }): FocusIntent;
  /** `within`: a zoomed root; its empty last child gets a sibling instead of leaving it. */
  enterOnEmpty(id: TodayNodeId, options?: { within?: TodayNodeId }): FocusIntent;
  /** `within`: a zoomed root. The neighbour merged with is taken from its subtree's rows. */
  mergeWithPrevious(id: TodayNodeId, options?: { within?: TodayNodeId }): FocusIntent;
  mergeWithNext(id: TodayNodeId, options?: { within?: TodayNodeId }): FocusIntent;
  indent(ids: readonly TodayNodeId[]): boolean;
  /** `within`: a zoomed root. Nothing moves when a node would leave its subtree. */
  outdent(ids: readonly TodayNodeId[], options?: { within?: TodayNodeId }): boolean;
  moveUp(ids: readonly TodayNodeId[]): boolean;
  moveDown(ids: readonly TodayNodeId[]): boolean;
  moveTo(ids: readonly TodayNodeId[], target: TodayMoveTarget): boolean;
  cycleTodo(ids: readonly TodayNodeId[]): boolean;
  setTodo(ids: readonly TodayNodeId[], state: TodayTodoState | undefined): boolean;
  /**
   * Fold or unfold a node for this viewer and in the document. Not an undo
   * step (its commit uses a `sys:` origin).
   */
  setCollapsed(id: TodayNodeId, collapsed: boolean): void;
  /**
   * The view changed without a document change (a fold this viewer kept while
   * a peer changed it in the document was rewritten to the same value).
   */
  onViewChange(listener: () => void): () => void;
  dispose(): void;
  /** Focus moves to the previous surviving row (of a zoomed root's subtree with `within`). */
  deleteNodes(ids: readonly TodayNodeId[], options?: { within?: TodayNodeId }): FocusIntent;
  /** Replace `deleteCount` characters at `offset` with one mention; the caret lands after it. */
  insertMention(
    id: TodayNodeId,
    offset: number,
    deleteCount: number,
    mention: TodayMentionTarget
  ): FocusIntent;
  /** A new node holding just a mention. */
  insertMentionNode(target: TodayMoveTarget, mention: TodayMentionTarget): FocusIntent;
  /**
   * Convert to task succeeded: when the node still reads `snapshot` the line
   * becomes just the mention with its children folded; otherwise the mention
   * and a space are prefixed. False when the node is gone.
   */
  convertToMention(id: TodayNodeId, mention: TodayMentionTarget, snapshot: TodayRichText): boolean;
  extract(ids: readonly TodayNodeId[]): TodayFragment[];
  paste(position: TodayPastePosition, fragments: readonly TodayFragment[]): FocusIntent;
};

/** Writers must configure the mention style before marking (Loro rejects unconfigured marks). */
export function configureTodayTextStyles(doc: LoroDoc): void {
  doc.configTextStyle({ [TODAY_MENTION_MARK]: { expand: 'none' } });
}

function readMentionMark(value: unknown): TodayMentionTarget | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, id } = value as Record<string, unknown>;
  return typeof kind === 'string' && kind && typeof id === 'string' && id ? { kind, id } : null;
}

/**
 * The one reader of node text: plain text plus a mention for every U+FFFC.
 * Adjacent mentions of one conversation merge into a single delta span, so
 * spans are split per character; a mark on any other character is ignored.
 */
export function readTodayText(text: LoroText): TodayRichText {
  let out = '';
  const mentions: TodayMention[] = [];
  for (const span of text.toDelta()) {
    if (typeof span.insert !== 'string') continue;
    const mark = readMentionMark(span.attributes?.[TODAY_MENTION_MARK]);
    for (let index = 0; index < span.insert.length; index += 1) {
      if (span.insert[index] !== TODAY_MENTION_CHAR) continue;
      mentions.push({ start: out.length + index, kind: mark?.kind ?? '', id: mark?.id ?? '' });
    }
    out += span.insert;
  }
  return { text: out, mentions };
}

/** `[start, end)` of rich text, mentions rebased. */
export function sliceTodayRich(rich: TodayRichText, start: number, end = rich.text.length) {
  return {
    text: rich.text.slice(start, end),
    mentions: rich.mentions
      .filter((mention) => mention.start >= start && mention.start < end)
      .map((mention) => ({ ...mention, start: mention.start - start })),
  };
}

/** Mentions that really sit on a U+FFFC of `text`, ordered. */
function validMentions(rich: TodayFragment | TodayRichText): TodayMention[] {
  return (rich.mentions ?? [])
    .filter(
      (mention) =>
        Number.isInteger(mention.start) && rich.text[mention.start] === TODAY_MENTION_CHAR
    )
    .sort((a, b) => a.start - b.start);
}

/**
 * Insert rich text at `at` with one delta. Every U+FFFC carries its mark (or
 * none for an unknown placeholder); plain runs carry no attributes, so they
 * never inherit a neighbouring mention.
 */
export function insertTodayRich(text: LoroText, at: number, rich: TodayRichText | TodayFragment) {
  if (!rich.text) return;
  const byStart = new Map(validMentions(rich).map((mention) => [mention.start, mention] as const));
  const delta: Delta<string>[] = at > 0 ? [{ retain: at }] : [];
  let run = '';
  const flush = () => {
    if (run) delta.push({ insert: run });
    run = '';
  };
  for (let index = 0; index < rich.text.length; index += 1) {
    const char = rich.text[index]!;
    const mention = char === TODAY_MENTION_CHAR ? byStart.get(index) : undefined;
    if (!mention?.kind) {
      run += char;
      continue;
    }
    flush();
    delta.push({
      insert: TODAY_MENTION_CHAR,
      attributes: { [TODAY_MENTION_MARK]: { kind: mention.kind, id: mention.id } },
    });
  }
  flush();
  text.applyDelta(delta);
}

/** Same text and the same mention at every position. */
export const sameTodayRich = (a: TodayRichText, b: TodayRichText) =>
  a.text === b.text &&
  a.mentions.length === b.mentions.length &&
  a.mentions.every(
    (mention, index) =>
      mention.start === b.mentions[index]!.start &&
      mention.kind === b.mentions[index]!.kind &&
      mention.id === b.mentions[index]!.id
  );

const mentionRich = (mention: TodayMentionTarget, suffix = ''): TodayRichText => ({
  text: TODAY_MENTION_CHAR + suffix,
  mentions: [{ start: 0, ...mention }],
});

type Node = LoroTreeNode;

export function openTodayOutline(doc: LoroDoc, options: { origin?: string } = {}): TodayOutline {
  const origin = options.origin ?? TODAY_OUTLINE_EDIT_ORIGIN;
  const tree: LoroTree = doc.getTree(TODAY_OUTLINE_TREE);
  tree.enableFractionalIndex(TODAY_FRACTIONAL_INDEX_JITTER);
  configureTodayTextStyles(doc);

  const commit = () => doc.commit({ origin });

  // Folds are stored in the page so it opens as it was left, but a peer's fold
  // change does not reach a viewer already looking at the page: `viewFolds`
  // keeps this viewer's fold for nodes a peer refolded, until this viewer
  // folds or unfolds them. Specs/today-outline.md (Data ownership).
  const viewFolds = new Map<string, boolean>();
  /**
   * Snapshot caches, kept exact by the synchronous commit events: node text by
   * node id (dropped when its LoroText changes), and the last snapshot, rebuilt
   * in full only after a structural change.
   */
  const richCache = new Map<string, TodayRichText>();
  const textOwner = new Map<string, string>();
  let cachedSnapshot: TodayPageSnapshot | null = null;
  /** Row of each visible node in `cachedSnapshot`, and every node's last view. */
  let indexById = new Map<string, number>();
  /**
   * Bumped when text changes on a node the snapshot hides under a fold: the
   * snapshot stays the same object then, but a zoomed subtree may show the node.
   */
  let hiddenTextRevision = 0;
  const subtreeCache = new Map<
    string,
    { from: TodayPageSnapshot; revision: number; subtree: TodayPageSnapshot }
  >();
  const viewById = new Map<string, TodayNodeView>();
  let structureDirty = true;
  const dirtyText = new Set<string>();
  /**
   * The tree's shape mirrored in JS (child ids per parent, '' for the roots),
   * kept by tree events: reading it costs no calls into the document.
   */
  const ROOT_KEY = '';
  const kids = new Map<string, string[]>();
  let mirrorBroken = true;
  const listOf = (parent: TreeID | undefined) => {
    const key = parent ?? ROOT_KEY;
    let list = kids.get(key);
    if (!list) kids.set(key, (list = []));
    return list;
  };
  const detach = (target: string, parent: TreeID | undefined, index: number) => {
    const list = listOf(parent);
    const at = list[index] === target ? index : list.indexOf(target);
    if (at < 0) mirrorBroken = true;
    else list.splice(at, 1);
  };
  const attach = (target: string, parent: TreeID | undefined, index: number) => {
    const list = listOf(parent);
    if (index > list.length) mirrorBroken = true;
    list.splice(Math.min(index, list.length), 0, target);
  };
  const stopCacheWatch = doc.subscribe((batch) => {
    for (const event of batch.events) {
      if (event.diff.type === 'tree') {
        structureDirty = true;
        if (mirrorBroken) continue;
        for (const item of event.diff.diff) {
          if (item.action === 'create') attach(item.target, item.parent, item.index);
          else if (item.action === 'delete') detach(item.target, item.oldParent, item.oldIndex);
          else {
            detach(item.target, item.oldParent, item.oldIndex);
            attach(item.target, item.parent, item.index);
          }
        }
        continue;
      }
      if (event.diff.type === 'text') {
        const owner = textOwner.get(String(event.target));
        if (owner === undefined) continue;
        richCache.delete(owner);
        dirtyText.add(owner);
      } else structureDirty = true;
    }
  });
  const viewListeners = new Set<() => void>();
  const docFold = (node: Node) => node.data.get('collapsed') === true;
  /**
   * Fold and to-do state per node as last committed, for snapshots; dropped
   * when the node's data map changes. Operations read the document directly.
   */
  type NodeAttrs = { collapsed: boolean; todo: TodayTodoState | undefined };
  const attrCache = new Map<string, NodeAttrs>();
  const dataOwner = new Map<string, string>();
  const readAttrs = (node: Node): NodeAttrs => {
    const id = node.id as string;
    const cached = attrCache.get(id);
    if (cached) return cached;
    dataOwner.set(String(node.data.id), id);
    const todo = node.data.get('todo');
    const attrs = {
      collapsed: node.data.get('collapsed') === true,
      todo: isTodayTodoState(todo) ? todo : undefined,
    };
    attrCache.set(id, attrs);
    return attrs;
  };
  /**
   * Every node's fold as this viewer first sees it: an imported change then
   * keeps this viewer's previous fold of that node.
   */
  const registerAll = (nodes: Node[]) => {
    for (const node of nodes) {
      readAttrs(node);
      registerAll(node.children() ?? []);
    }
  };
  registerAll(tree.roots());
  const stopFoldWatch = doc.subscribe((batch) => {
    for (const event of batch.events) {
      if (event.diff.type === 'tree') {
        for (const item of event.diff.diff) {
          if (item.action !== 'create') continue;
          const created = tree.getNodeByID(item.target);
          if (created && !created.isDeleted()) readAttrs(created);
        }
        continue;
      }
      if (event.diff.type !== 'map') continue;
      const id = dataOwner.get(String(event.target));
      if (id === undefined) continue;
      const before = attrCache.get(id);
      attrCache.delete(id);
      const node = tree.getNodeByID(id as TodayNodeId);
      if (!node || node.isDeleted()) continue;
      const now = readAttrs(node).collapsed;
      if (batch.by === 'import' && before && before.collapsed !== now && !viewFolds.has(id)) {
        viewFolds.set(id, before.collapsed);
      }
      if (viewFolds.get(id) === now) viewFolds.delete(id);
    }
  });
  /** Write a fold through the document and drop this viewer's kept fold. */
  const writeFold = (node: Node, collapsed: boolean) => {
    const kept = viewFolds.delete(node.id as string);
    if (docFold(node) === collapsed) {
      if (kept) {
        structureDirty = true;
        for (const listener of viewListeners) listener();
      }
      return false;
    }
    if (collapsed) node.data.set('collapsed', true);
    else node.data.delete('collapsed');
    return true;
  };

  const live = (id: TodayNodeId): Node | undefined => {
    const node = tree.getNodeByID(id);
    return node && !node.isDeleted() ? node : undefined;
  };
  const textOf = (node: Node): LoroText | undefined => {
    const value = node.data.get('text');
    return value instanceof LoroText ? value : undefined;
  };
  const readRich = (node: Node): TodayRichText => {
    const text = textOf(node);
    return text ? readTodayText(text) : { text: '', mentions: [] };
  };
  const isCollapsed = (node: Node) => viewFolds.get(node.id as string) ?? docFold(node);
  const todoOf = (node: Node): TodayTodoState | undefined => {
    const value = node.data.get('todo');
    return isTodayTodoState(value) ? value : undefined;
  };
  const writeTodo = (node: Node, state: TodayTodoState | undefined) => {
    if (todoOf(node) === state) return false;
    if (state) node.data.set('todo', state);
    else node.data.delete('todo');
    return true;
  };
  const childrenOf = (parent: Node | undefined): Node[] =>
    parent ? (parent.children() ?? []) : tree.roots();
  const siblingsOf = (node: Node) => childrenOf(node.parent());
  const indexOf = (node: Node) => node.index() ?? 0;

  const cachedRich = (node: Node): TodayRichText => {
    const id = node.id as string;
    const cached = richCache.get(id);
    if (cached) return cached;
    const text = textOf(node);
    if (text) textOwner.set(String(text.id), id);
    const rich = text ? readTodayText(text) : { text: '', mentions: [] };
    richCache.set(id, rich);
    return rich;
  };

  const view = (node: Node, depth: number, children = childrenOf(node)): TodayNodeView => {
    const rich = cachedRich(node);
    const todo = todoOf(node);
    return {
      id: node.id,
      parentId: node.parent()?.id ?? null,
      depth,
      text: rich.text,
      mentions: rich.mentions,
      collapsed: isCollapsed(node),
      hasChildren: children.length > 0,
      ...(todo ? { todo } : {}),
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
    content: {
      text?: string;
      mentions?: TodayMention[];
      collapsed?: boolean;
      todo?: TodayTodoState;
    }
  ): Node => {
    const node = parent ? parent.createNode(index) : tree.createNode(undefined, index);
    const text = node.data.setContainer('text', new LoroText());
    if (content.text)
      insertTodayRich(text, 0, { text: content.text, mentions: content.mentions ?? [] });
    if (content.collapsed) node.data.set('collapsed', true);
    if (isTodayTodoState(content.todo)) node.data.set('todo', content.todo);
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

  /** The rows the caret walks: the page's visible rows, or a zoomed root followed by its subtree. */
  const visibleRows = (within?: TodayNodeId): TodayNodeId[] => {
    if (!within) return outline.getSnapshot().visible.map((node) => node.id);
    const subtree = outline.getSubtree(within);
    return subtree ? [within, ...subtree.visible.map((node) => node.id)] : [];
  };

  const visibleNeighbour = (id: TodayNodeId, step: -1 | 1, within?: TodayNodeId) => {
    const rows = visibleRows(within);
    const index = rows.indexOf(id);
    return index < 0 ? undefined : rows[index + step];
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

  /**
   * Live nodes split into runs of adjacent siblings (same parent, consecutive
   * indexes), in the given order. A block selection's top-level nodes can span
   * parents; structural moves apply to one run at a time.
   */
  const siblingRuns = (ids: readonly TodayNodeId[]): Node[][] | undefined => {
    const nodes = liveAll(ids);
    if (!nodes) return undefined;
    const runs: Node[][] = [];
    for (const node of nodes) {
      const run = runs.at(-1);
      const last = run?.at(-1);
      if (
        run &&
        last &&
        last.parent()?.id === node.parent()?.id &&
        indexOf(last) + 1 === indexOf(node)
      ) {
        run.push(node);
      } else {
        runs.push([node]);
      }
    }
    return runs;
  };

  const indentRun = (nodes: Node[]): boolean => {
    const first = nodes[0]!;
    const index = indexOf(first);
    if (index === 0) return false;
    const target = siblingsOf(first)[index - 1];
    if (!target) return false;
    if (isCollapsed(target)) writeFold(target, false);
    for (const node of nodes) node.move(target);
    return true;
  };

  const outdentRun = (nodes: Node[]): boolean => {
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
    return true;
  };

  /** One run of adjacent siblings, or nothing: moving blocks of several levels together is ambiguous. */
  const singleRun = (ids: readonly TodayNodeId[]): Node[] | undefined => {
    const runs = siblingRuns(ids);
    return runs?.length === 1 ? runs[0] : undefined;
  };

  const toFragment = (node: Node): TodayFragment => {
    const rich = readRich(node);
    return {
      text: rich.text,
      ...(rich.mentions.length > 0 ? { mentions: rich.mentions } : {}),
      ...(isCollapsed(node) ? { collapsed: true } : {}),
      ...(todoOf(node) ? { todo: todoOf(node) } : {}),
      children: childrenOf(node).map(toFragment),
    };
  };

  const ensureMirror = () => {
    if (!mirrorBroken) return;
    kids.clear();
    const mirror = (key: string, nodes: Node[]) => {
      kids.set(
        key,
        nodes.map((node) => {
          const id = node.id as string;
          mirror(id, node.children() ?? []);
          return id;
        })
      );
    };
    mirror(ROOT_KEY, tree.roots());
    mirrorBroken = false;
  };

  const someNodeHasText = () => {
    const visit = (nodes: Node[]): boolean =>
      nodes.some((node) => !!cachedRich(node).text.trim() || visit(childrenOf(node)));
    return visit(tree.roots());
  };

  const outline: TodayOutline = {
    getAllNodes: () => walk(false),
    childIds: (parentId) => {
      ensureMirror();
      return [...(kids.get(parentId ?? ROOT_KEY) ?? [])] as TodayNodeId[];
    },
    // One pass: every node is read once, whether or not a fold hides it
    // (hidden nodes still count for `isEmpty`).
    getSnapshot: () => {
      const previous = cachedSnapshot;
      if (previous && !structureDirty) {
        if (dirtyText.size === 0) return previous;
        let visible = previous.visible;
        let changed = false;
        for (const id of dirtyText) {
          const node = live(id as TodayNodeId);
          if (!node) {
            structureDirty = true;
            break;
          }
          const rich = cachedRich(node);
          const index = indexById.get(id);
          if (index === undefined) {
            hiddenTextRevision += 1;
            continue;
          }
          if (!changed) visible = [...previous.visible];
          changed = true;
          const nodeView = {
            ...previous.visible[index]!,
            text: rich.text,
            mentions: rich.mentions,
          };
          (visible as TodayNodeView[])[index] = nodeView;
          viewById.set(id, nodeView);
        }
        if (!structureDirty) {
          const edited = [...dirtyText];
          dirtyText.clear();
          const isEmpty =
            previous.isEmpty || edited.some((id) => !richCache.get(id)?.text.trim())
              ? !someNodeHasText()
              : false;
          cachedSnapshot =
            changed || isEmpty !== previous.isEmpty
              ? { visible, isEmpty, layout: previous.layout }
              : previous;
          return cachedSnapshot;
        }
      }
      const visible: TodayNodeView[] = [];
      const nextIndex = new Map<string, number>();
      let isEmpty = true;
      ensureMirror();
      const visit = (key: string, depth: number, hidden: boolean, parentId: TodayNodeId | null) => {
        for (const raw of kids.get(key) ?? []) {
          const id = raw as TodayNodeId;
          const children = kids.get(raw);
          let rich = richCache.get(raw);
          let attrs = attrCache.get(raw);
          if (!rich || !attrs) {
            const node = live(id);
            if (!node) continue;
            rich = cachedRich(node);
            attrs = readAttrs(node);
          }
          const collapsed = viewFolds.get(raw) ?? attrs.collapsed;
          const hasChildren = !!children && children.length > 0;
          if (isEmpty && rich.text.trim()) isEmpty = false;
          if (!hidden) {
            // Unchanged rows keep their object, so memoized rows skip rendering.
            const old = viewById.get(raw);
            const nodeView =
              old &&
              old.text === rich.text &&
              old.mentions === rich.mentions &&
              old.parentId === parentId &&
              old.depth === depth &&
              old.collapsed === collapsed &&
              old.hasChildren === hasChildren &&
              old.todo === attrs.todo
                ? old
                : {
                    id,
                    parentId,
                    depth,
                    text: rich.text,
                    mentions: rich.mentions,
                    collapsed,
                    hasChildren,
                    ...(attrs.todo ? { todo: attrs.todo } : {}),
                  };
            if (nodeView !== old) viewById.set(raw, nodeView);
            nextIndex.set(raw, visible.length);
            visible.push(nodeView);
          }
          visit(raw, depth + 1, hidden || collapsed, id);
        }
      };
      visit(ROOT_KEY, 0, false, null);
      structureDirty = false;
      dirtyText.clear();
      indexById = nextIndex;
      cachedSnapshot = { visible, isEmpty, layout: {} };
      return cachedSnapshot;
    },
    getSubtree: (rootId) => {
      const snapshot = outline.getSnapshot();
      if (!live(rootId)) return null;
      const cached = subtreeCache.get(rootId);
      if (cached && cached.from === snapshot && cached.revision === hiddenTextRevision) {
        return cached.subtree;
      }
      const previous = new Map(cached?.subtree.visible.map((row) => [row.id as string, row]));
      const visible: TodayNodeView[] = [];
      let isEmpty = true;
      const visit = (key: string, depth: number, parentId: TodayNodeId) => {
        for (const raw of kids.get(key) ?? []) {
          const id = raw as TodayNodeId;
          const node = richCache.has(raw) && attrCache.has(raw) ? undefined : live(id);
          const rich = node ? cachedRich(node) : richCache.get(raw)!;
          const attrs = node ? readAttrs(node) : attrCache.get(raw)!;
          if (!rich || !attrs) continue;
          const children = kids.get(raw);
          const collapsed = viewFolds.get(raw) ?? attrs.collapsed;
          const hasChildren = !!children && children.length > 0;
          if (isEmpty && rich.text.trim()) isEmpty = false;
          const old = previous.get(raw);
          visible.push(
            old &&
              old.text === rich.text &&
              old.mentions === rich.mentions &&
              old.parentId === parentId &&
              old.depth === depth &&
              old.collapsed === collapsed &&
              old.hasChildren === hasChildren &&
              old.todo === attrs.todo
              ? old
              : {
                  id,
                  parentId,
                  depth,
                  text: rich.text,
                  mentions: rich.mentions,
                  collapsed,
                  hasChildren,
                  ...(attrs.todo ? { todo: attrs.todo } : {}),
                }
          );
          if (!collapsed) visit(raw, depth + 1, id);
        }
      };
      visit(rootId, 0, rootId);
      const layout = cached && cached.from.layout === snapshot.layout ? cached.subtree.layout : {};
      const subtree = { visible, isEmpty, layout };
      subtreeCache.set(rootId, { from: snapshot, revision: hiddenTextRevision, subtree });
      return subtree;
    },
    getNode: (id) => {
      const node = live(id);
      return node ? view(node, depthOf(node)) : undefined;
    },
    getText: (id) => {
      const node = live(id);
      return node ? textOf(node) : undefined;
    },

    insertFirst: (text = '', parentId) => {
      const parent = parentId ? live(parentId) : undefined;
      if (parentId && !parent) return null;
      const node = parent
        ? create(parent, 0, { text })
        : create(undefined, tree.roots().length, { text });
      commit();
      return { nodeId: node.id, offset: text.length };
    },

    split: (id, offset, options) => {
      const node = live(id);
      const text = node && textOf(node);
      if (!node || !text) return null;
      const length = text.length;
      const todo = todoOf(node) ? ('todo' as const) : undefined;
      if (offset <= 0 && length > 0 && options?.intoChildren) {
        const child = create(node, 0, { todo });
        commit();
        return { nodeId: child.id, offset: 0 };
      }
      if (offset <= 0 && length > 0) {
        create(node.parent(), indexOf(node), { todo });
        commit();
        return { nodeId: id, offset: 0 };
      }
      const right = { ...sliceTodayRich(readTodayText(text), offset), todo };
      if (right.text) text.delete(offset, length - offset);
      const intoChildren =
        options?.intoChildren || (childrenOf(node).length > 0 && !isCollapsed(node));
      const created = intoChildren
        ? create(node, 0, right)
        : create(node.parent(), indexOf(node) + 1, right);
      commit();
      return { nodeId: created.id, offset: 0 };
    },

    enterOnEmpty: (id, options) => {
      const node = live(id);
      if (!node) return null;
      if (writeTodo(node, undefined)) {
        commit();
        return { nodeId: id, offset: 0 };
      }
      const parent = node.parent();
      const siblings = siblingsOf(node);
      if (parent && parent.id !== options?.within && siblings.at(-1)?.id === node.id) {
        node.moveAfter(parent);
        commit();
        return { nodeId: id, offset: 0 };
      }
      const created = create(parent, indexOf(node) + 1, {});
      commit();
      return { nodeId: created.id, offset: 0 };
    },

    mergeWithPrevious: (id, options) => {
      const node = live(id);
      const previousId = visibleNeighbour(id, -1, options?.within);
      const previous = previousId && live(previousId);
      if (!node || !previous) return null;
      const previousText = textOf(previous);
      if (!previousText) return null;
      if (!previousText.length && childrenOf(previous).length === 0) {
        tree.delete(previous.id);
        commit();
        return { nodeId: id, offset: 0 };
      }
      const offset = previousText.length;
      insertTodayRich(previousText, offset, readRich(node));
      // Merging into a folded node would hide the merged line's children under
      // it: unfold it, as indenting under it does.
      if (
        previous.id !== options?.within &&
        isCollapsed(previous) &&
        childrenOf(previous).length > 0
      ) {
        writeFold(previous, false);
      }
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

    mergeWithNext: (id, options) => {
      const node = live(id);
      const text = node && textOf(node);
      if (!node || !text) return null;
      if (id !== options?.within && isCollapsed(node) && childrenOf(node).length > 0) return null;
      const nextId = visibleNeighbour(id, 1, options?.within);
      const next = nextId && live(nextId);
      if (!next) return null;
      const offset = text.length;
      insertTodayRich(text, offset, readRich(next));
      if (next.parent()?.id === node.id) {
        for (const child of childrenOf(next)) child.moveBefore(next);
      } else {
        appendChildrenOf(next, node);
      }
      tree.delete(next.id);
      commit();
      return { nodeId: id, offset };
    },

    // Each run as if indented on its own, in document order.
    indent: (ids) => {
      const runs = siblingRuns(ids);
      if (!runs) return false;
      let changed = false;
      for (const run of runs) changed = indentRun(run) || changed;
      if (changed) commit();
      return changed;
    },

    // Each run as if outdented on its own, last first, so an earlier run's
    // followers (its later siblings) are taken as they stand.
    outdent: (ids, options) => {
      const runs = siblingRuns(ids);
      if (!runs) return false;
      if (options?.within && runs.some((run) => run[0]!.parent()?.id === options.within)) {
        return false;
      }
      let changed = false;
      for (const run of [...runs].reverse()) changed = outdentRun(run) || changed;
      if (changed) commit();
      return changed;
    },

    moveUp: (ids) => {
      const nodes = singleRun(ids);
      if (!nodes) return false;
      const first = nodes[0]!;
      const previous = siblingsOf(first)[indexOf(first) - 1];
      if (!previous) return false;
      previous.moveAfter(nodes.at(-1)!);
      commit();
      return true;
    },

    moveDown: (ids) => {
      const nodes = singleRun(ids);
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

    cycleTodo: (ids) => {
      const nodes = liveAll(ids);
      if (!nodes || nodes.length === 0) return false;
      for (const node of nodes) writeTodo(node, nextTodayTodoState(todoOf(node)));
      commit();
      return true;
    },

    setTodo: (ids, state) => {
      const nodes = liveAll(ids);
      if (!nodes) return false;
      let changed = false;
      for (const node of nodes) changed = writeTodo(node, state) || changed;
      if (changed) commit();
      return changed;
    },

    setCollapsed: (id, collapsed) => {
      const node = live(id);
      if (!node || isCollapsed(node) === collapsed) return;
      if (writeFold(node, collapsed)) doc.commit({ origin: TODAY_OUTLINE_FOLD_ORIGIN });
    },

    onViewChange: (listener) => {
      viewListeners.add(listener);
      return () => viewListeners.delete(listener);
    },

    dispose: () => {
      stopFoldWatch();
      stopCacheWatch();
      viewListeners.clear();
    },

    deleteNodes: (ids, options) => {
      const nodes = liveAll(ids);
      if (!nodes) return null;
      const removed = new Set(ids);
      const visible = visibleRows(options?.within);
      const firstIndex = visible.findIndex((id) => removed.has(id));
      const isRemoved = (candidate: TodayNodeId) =>
        nodes.some((node) => isWithin(live(candidate), node.id));
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
      return survivor ? { nodeId: survivor, offset: 'end' } : null;
    },

    insertMention: (id, offset, deleteCount, mention) => {
      const node = live(id);
      const text = node && textOf(node);
      if (!node || !text) return null;
      const start = Math.min(Math.max(offset, 0), text.length);
      const removed = Math.min(Math.max(deleteCount, 0), text.length - start);
      if (removed > 0) text.delete(start, removed);
      insertTodayRich(text, start, mentionRich(mention));
      commit();
      return { nodeId: id, offset: start + 1 };
    },

    insertMentionNode: (target, mention) => {
      const parent = target.parentId === null ? undefined : live(target.parentId);
      if (target.parentId !== null && !parent) return null;
      const index = Math.min(target.index, childrenOf(parent).length);
      const node = create(parent, index, mentionRich(mention));
      commit();
      return { nodeId: node.id, offset: 'end' };
    },

    convertToMention: (id, mention, snapshot) => {
      const node = live(id);
      const text = node && textOf(node);
      if (!node || !text) return false;
      if (sameTodayRich(readTodayText(text), snapshot)) {
        if (text.length > 0) text.delete(0, text.length);
        insertTodayRich(text, 0, mentionRich(mention));
        if (childrenOf(node).length > 0) writeFold(node, true);
      } else {
        insertTodayRich(text, 0, mentionRich(mention, ' '));
      }
      commit();
      return true;
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

      if (fragments.length === 1 && head.children.length === 0) {
        insertTodayRich(text, offset, head);
        commit();
        return { nodeId: node.id, offset: offset + head.text.length };
      }

      const tail = sliceTodayRich(readTodayText(text), offset);
      if (tail.text) text.delete(offset, tail.text.length);
      insertTodayRich(text, offset, head);
      head.children.forEach((child, index) => createFragment(node, index, child));
      let lastNode = node;
      let lastText = text;
      rest.forEach((fragment, index) => {
        lastNode = createFragment(node.parent(), indexOf(node) + 1 + index, fragment);
        lastText = textOf(lastNode)!;
      });
      const caret = lastText.length;
      insertTodayRich(lastText, caret, tail);
      commit();
      return { nodeId: lastNode.id, offset: caret };
    },
  };
  return outline;
}

const FENCE_PATTERN = /^(```|~~~)/;
const BULLET_PATTERN = /^[-*+•]\s+/;
const TASK_PATTERN = /^\[([ xX])\]\s+/;

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
  // U+FFFC only means a mention when it carries a mark; pasted text has none.
  const lines = input.replace(/\r\n?/g, '\n').replaceAll(TODAY_MENTION_CHAR, '').split('\n');
  const roots: TodayFragment[] = [];
  const stack: { indent: number; fragment: TodayFragment }[] = [];
  const place = (indent: number, text: string, todo?: TodayTodoState) => {
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const fragment: TodayFragment = { text, ...(todo ? { todo } : {}), children: [] };
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
    const unbulleted = trimmed.replace(BULLET_PATTERN, '');
    const task = unbulleted === trimmed ? null : TASK_PATTERN.exec(unbulleted);
    if (task) place(indent, unbulleted.slice(task[0].length), task[1] === ' ' ? 'todo' : 'done');
    else place(indent, unbulleted);
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
