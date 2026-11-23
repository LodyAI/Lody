import * as stylex from '@stylexjs/stylex';
import { Check, ChevronRight, MoreHorizontal, Plus } from 'lucide-react';
import {
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { getTodayDocId, type TodayDate, type TodayNodeId, type TodayNodeView } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { TodayEditorContext, useTodayEditor } from './editor/today-editor-context';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { TodayMentionDecorators } from './editor/today-mention-decorators';
import { TODAY_INDENT_PX, type TodayEditorController } from './editor/today-editor-controller';
import { TodayMention } from './today-session-mention';
import type { TodayPageStore } from '@/lib/today/today-page-store';
import type { TodayPageStoreCache } from '../../providers/today-page-store-cache';
import { formatTodayHeading } from './today-stream';
import { TodayMoreAtEndContext, todayOutline, todaySurfaceMarker } from './outline.stylex';

const styles = stylex.create({
  section: { display: 'flex', flexDirection: 'column', gap: space[1], paddingBlock: space[3] },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: space[2],
    fontSize: text.headlineSize,
    lineHeight: text.headlineLeading,
    fontWeight: 600,
    color: colors.label,
  },
  headerMeta: { fontWeight: 400, color: colors.secondaryLabel },
  headerButton: {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: space[2],
    padding: 0,
    borderWidth: 0,
    background: 'none',
    font: 'inherit',
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'start',
    textDecorationLine: { default: 'none', ':hover': 'underline' },
    textDecorationColor: colors.tertiaryLabel,
    textUnderlineOffset: '4px',
  },
  rowTitle: { marginInlineStart: 0, position: 'relative' },
  titleText: {
    fontSize: text.headlineSize,
    lineHeight: text.headlineLeading,
    fontWeight: 600,
  },
  zoomGone: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minHeight: 28,
    fontSize: text.bodySize,
    color: colors.secondaryLabel,
  },
  more: {
    position: 'absolute',
    top: 0,
    width: 16,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.mini,
    background: 'none',
    color: { default: colors.tertiaryLabel, ':hover': colors.label },
    cursor: 'pointer',
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover')]: 1,
      ':focus-visible': 1,
    },
    transitionProperty: 'opacity',
    transitionDuration: '100ms',
  },
  outline: { display: 'flex', flexDirection: 'column', minHeight: 28 },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[1],
    minHeight: 28,
    borderRadius: radius.mini,
    // Hang the fold toggle in the margin (`todayOutline.foldOverhang`).
    marginInlineStart: `calc(-1 * ${todayOutline.foldOverhang})`,
    position: 'relative',
  },
  // 12px wide and flush against the bullet box (the negative end margin takes
  // back the row gap), so its centre is 14px left of the dot's. Its hit area
  // (the `::before`) reaches 6px further left into the empty margin and stops
  // 2px short of the bullet, whose own hit area is inset 1px: a 3px dead gap
  // between the two. Only the glyph rotates, so an open toggle's box never
  // turns sideways over the bullet. It shows only
  // while its line is hovered, focused from the keyboard or being edited; a
  // folded node keeps its ringed dot as the resting cue.
  fold: {
    position: 'relative',
    width: 12,
    height: 28,
    marginInlineEnd: `calc(-1 * ${space[1]})`,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: colors.tertiaryLabel,
    background: 'none',
    borderWidth: 0,
    padding: 0,
    cursor: 'pointer',
    flexShrink: 0,
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover')]: 1,
      ':focus-visible': 1,
    },
    transitionProperty: 'opacity',
    transitionDuration: '100ms',
    pointerEvents: 'none',
    '::before': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: -6,
      right: 2,
      pointerEvents: 'auto',
    },
  },
  foldShown: { opacity: 1 },
  foldHidden: { visibility: 'hidden' },
  foldOpen: { transform: 'rotate(90deg)' },
  bullet: {
    position: 'relative',
    pointerEvents: 'none',
    '::before': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 1,
      right: 1,
      pointerEvents: 'auto',
    },
    width: 16,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  halo: {
    width: 16,
    height: 16,
    borderRadius: radius.full,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    pointerEvents: 'auto',
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    transitionProperty: 'background-color',
    transitionDuration: '100ms',
  },
  // Where the first child's fold toggle would sit (see `fold`).
  foldSpace: { width: 12, marginInlineEnd: `calc(-1 * ${space[1]})`, flexShrink: 0 },
  addChild: {
    width: '100%',
    background: 'none',
    borderWidth: 0,
    padding: 0,
    font: 'inherit',
    textAlign: 'start',
    cursor: 'text',
  },
  addChildPlus: {
    color: { default: colors.tertiaryLabel, ':hover': colors.secondaryLabel },
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover', todaySurfaceMarker)]: 1,
      '@media (hover: none)': 1,
    },
    transitionProperty: 'opacity, background-color',
  },
  dot: { width: 6, height: 6, borderRadius: radius.full, backgroundColor: colors.secondaryLabel },
  dotFolded: { boxShadow: `0 0 0 4px ${colors.selectedFill}` },
  dotQuiet: {
    opacity: { default: 0, [stylex.when.ancestor(':hover')]: 1 },
    transitionProperty: 'opacity',
    transitionDuration: '100ms',
  },
  check: {
    width: 16,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    cursor: 'pointer',
  },
  checkBox: {
    boxSizing: 'border-box',
    width: 14,
    height: 14,
    borderRadius: 4,
    borderWidth: 1.5,
    borderStyle: 'solid',
    borderColor: { default: colors.tertiaryLabel, ':hover': colors.secondaryLabel },
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: colors.onAccent,
  },
  checkBoxDone: {
    backgroundColor: colors.accent,
    borderColor: { default: colors.accent, ':hover': colors.accent },
  },
  textDone: { color: colors.secondaryLabel, textDecorationLine: 'line-through' },
  text: {
    flex: 1,
    minWidth: 0,
    paddingBlock: 4,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.label,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  placeholder: { color: colors.tertiaryLabel, cursor: 'text' },
  failed: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    fontSize: text.bodySize,
    color: colors.secondaryLabel,
  },
  editable: { outline: 'none', cursor: 'text' },
  handle: { cursor: 'pointer', touchAction: 'none' },
  blockSelected: { backgroundColor: `color-mix(in srgb, ${colors.accent} 14%, transparent)` },
  joinTop: { borderTopLeftRadius: 0, borderTopRightRadius: 0 },
  joinBottom: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
});

/**
 * One day of the stream. The page document is opened while the section is near
 * the viewport and released when it scrolls far away; a registered day found
 * empty after syncing reports itself so the stream can skip it.
 */
export function TodayDaySection(props: {
  cache: TodayPageStoreCache;
  userId: string;
  date: TodayDate;
  today: TodayDate;
  isTop: boolean;
  /** A day's synced page is empty (skipped from the stream), or holds content again. */
  onEmptyChange: (date: TodayDate, empty: boolean) => void;
  /** Shows only this node and its subtree, under its text as the title. */
  zoomRoot?: TodayNodeId | null;
  /** The date heading opens this day alone. */
  onOpenDay?: (date: TodayDate) => void;
}) {
  const { t, i18n } = useTranslation();
  const ref = useRef<HTMLElement | null>(null);
  const page = useNearViewportPage(ref, props.cache, getTodayDocId(props.userId, props.date));
  const heading = formatTodayHeading(props.date, props.today, i18n.language);
  const { onOpenDay, date } = props;
  const label = (
    <>
      {heading.isToday ? t('today.title', 'Today') : heading.date}
      <span {...stylex.props(styles.headerMeta)}>{heading.meta}</span>
    </>
  );
  return (
    <section ref={ref} {...stylex.props(styles.section)} data-today-date={props.date}>
      {props.zoomRoot ? null : (
        <h2 {...stylex.props(styles.header)}>
          {onOpenDay ? (
            <button
              type="button"
              {...stylex.props(styles.headerButton)}
              aria-label={t('today.openDay', 'Open {{date}} alone', { date: heading.date })}
              onClick={() => onOpenDay(date)}
            >
              {label}
            </button>
          ) : (
            label
          )}
        </h2>
      )}
      {page.store ? (
        <TodayStaticOutline
          store={page.store}
          isTop={props.isTop}
          onEmptyChange={props.onEmptyChange}
          zoomRoot={props.zoomRoot ?? null}
        />
      ) : page.failed ? (
        <div {...stylex.props(styles.outline, styles.failed)} role="alert">
          {t('today.pageOpenFailed', "Couldn't open this day.")}
          <Button size="small" variant="ghost" onClick={page.retry}>
            {t('common.retry', 'Retry')}
          </Button>
        </div>
      ) : (
        <div {...stylex.props(styles.outline)} />
      )}
    </section>
  );
}

function TodayStaticOutline(props: {
  store: TodayPageStore;
  zoomRoot: TodayNodeId | null;
  isTop: boolean;
  /** A day's synced page is empty (skipped from the stream), or holds content again. */
  onEmptyChange: (date: TodayDate, empty: boolean) => void;
}) {
  const { store, isTop, onEmptyChange } = props;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const controller = useTodayEditor();
  useEffect(() => controller?.registerDay(store.date, store), [controller, store]);
  useEffect(() => {
    if (isTop) return undefined;
    let cancelled = false;
    void store.synced.then(() => {
      if (!cancelled && store.getSnapshot().isEmpty) onEmptyChange(store.date, true);
    });
    return () => {
      cancelled = true;
    };
  }, [isTop, onEmptyChange, store]);
  // A day once found empty and written again (e.g. opened from the calendar)
  // must show in the stream again.
  useEffect(() => {
    if (!snapshot.isEmpty) onEmptyChange(store.date, false);
  }, [onEmptyChange, snapshot.isEmpty, store.date]);

  if (props.zoomRoot) return <TodayZoomedOutline store={store} root={props.zoomRoot} />;
  if (snapshot.visible.length === 0) {
    return (
      <div {...stylex.props(styles.outline)}>
        <TodayRow node={null} store={store} active={false} selected={false} />
      </div>
    );
  }
  if (snapshot.visible.length >= TODAY_VIRTUALIZE_FROM) {
    return <TodayVirtualOutline store={store} />;
  }
  return (
    <div {...stylex.props(styles.outline)} role="tree">
      {snapshot.visible.map((node, index) => (
        <TodayRow
          key={node.id}
          store={store}
          {...rowState(controller, store, snapshot.visible, index)}
        />
      ))}
    </div>
  );
}

/** Pages with at least this many visible rows render only the rows near the viewport. */
export const TODAY_VIRTUALIZE_FROM = 200;

/**
 * A node zoomed into: its text as the title (a row of its own, without a
 * bullet), then its subtree from depth 0 — virtualized like a large day.
 * Behavior: specs/today-outline.md (Focus view).
 */
function TodayZoomedOutline(props: { store: TodayPageStore; root: TodayNodeId }) {
  const { t } = useTranslation();
  const { store, root } = props;
  const controller = useTodayEditor();
  const readSubtree = useCallback(() => store.outline.getSubtree(root), [root, store]);
  const subtree = useSyncExternalStore(store.subscribe, readSubtree);
  const node = useMemo(() => {
    const view = subtree ? store.outline.getNode(root) : undefined;
    return view && { ...view, depth: 0 };
  }, [root, store, subtree]);
  if (!subtree || !node) {
    return (
      <div {...stylex.props(styles.zoomGone)} role="alert">
        {t('today.zoomGone', 'This node was deleted.')}
        <Button size="small" variant="ghost" onClick={() => controller?.onZoomOut?.()}>
          {t('today.zoomOut', 'Back to the parent')}
        </Button>
      </div>
    );
  }
  const rootSelected = !!controller?.isBlockSelected(store, root);
  return (
    <div {...stylex.props(styles.outline)} role="tree">
      <TodayRow
        node={node}
        store={store}
        title
        active={!!controller?.isActive(store, root)}
        selected={rootSelected}
      />
      {subtree.visible.length === 0 ? (
        <TodayAddChild store={store} parentId={root} />
      ) : subtree.visible.length >= TODAY_VIRTUALIZE_FROM ? (
        <TodayVirtualOutline store={store} zoomRoot={root} />
      ) : (
        subtree.visible.map((row, index) => (
          <TodayRow
            key={row.id}
            store={store}
            {...rowState(controller, store, subtree.visible, index)}
          />
        ))
      )}
    </div>
  );
}

/**
 * A zoomed node without children: a "+" where its first child's bullet would be,
 * shown while the surface is hovered. A click starts that child with the caret in it.
 */
function TodayAddChild(props: { store: TodayPageStore; parentId: TodayNodeId }) {
  const { t } = useTranslation();
  const controller = useTodayEditor();
  return (
    <button
      type="button"
      {...stylex.props(styles.row, styles.addChild)}
      aria-label={t('today.addChild', 'Add a child')}
      tabIndex={-1}
      data-today-add-child
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => controller?.startPage(props.store, props.parentId)}
    >
      <span {...stylex.props(styles.foldSpace)} />
      <span {...stylex.props(styles.bullet)}>
        <span {...stylex.props(styles.halo, styles.addChildPlus)}>
          <Plus size={12} strokeWidth={2.5} />
        </span>
      </span>
    </button>
  );
}

/** What a memoized row compares: its node and its editing and selection state. */
function rowState(
  controller: TodayEditorController | null,
  store: TodayPageStore,
  visible: readonly TodayNodeView[],
  index: number
) {
  const node = visible[index]!;
  const isSelected = (at: number) => {
    const other = visible[at];
    return !!other && !!controller?.isBlockSelected(store, other.id);
  };
  const selected = isSelected(index);
  return {
    node,
    active: !!controller?.isActive(store, node.id),
    selected,
    // A run of selected rows reads as one block: only its ends are rounded.
    joinsPrevious: selected && isSelected(index - 1),
    joinsNext: selected && isSelected(index + 1),
  };
}

/**
 * A large page: only the rows near the viewport (and the one being edited,
 * wherever it is) are mounted, positioned inside a box as tall as the whole
 * page. Rows are measured as they mount, so wrapped lines keep their height.
 */
function TodayVirtualOutline(props: { store: TodayPageStore; zoomRoot?: TodayNodeId }) {
  const { store, zoomRoot } = props;
  const readRows = useCallback(
    () => (zoomRoot ? (store.outline.getSubtree(zoomRoot) ?? EMPTY_ROWS) : store.getSnapshot()),
    [store, zoomRoot]
  );
  const snapshot = useSyncExternalStore(store.subscribe, readRows);
  const { visible, layout } = snapshot;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  /** Keys follow the rows' order, which changes only with the layout: typing keeps every measurement. */
  const getItemKey = useCallback((index: number) => visibleRef.current[index]!.id, [layout]);
  const controller = useTodayEditor();
  const outlineRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const scroller = useCallback(
    () => outlineRef.current?.closest<HTMLElement>('[data-today-scroller]') ?? null,
    []
  );
  useLayoutEffect(() => {
    const outline = outlineRef.current;
    const element = scroller();
    if (!outline || !element) return undefined;
    const update = () => {
      const margin =
        outline.getBoundingClientRect().top -
        element.getBoundingClientRect().top +
        element.scrollTop;
      setScrollMargin((previous) => (Math.abs(previous - margin) < 1 ? previous : margin));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element.firstElementChild ?? element);
    return () => observer.disconnect();
  }, [scroller]);
  const activeIndex = useMemo(() => {
    if (!controller) return -1;
    return visible.findIndex((node) => controller.isActive(store, node.id));
  }, [controller, store, visible, controller?.getVersion()]);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      // The node being edited stays mounted: unmounting would end its editor and IME.
      if (activeIndex >= 0 && !indexes.includes(activeIndex)) {
        indexes.push(activeIndex);
        indexes.sort((a, b) => a - b);
      }
      return indexes;
    },
    [activeIndex]
  );
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: visible.length,
    getScrollElement: scroller,
    estimateSize,
    overscan: 12,
    scrollMargin,
    getItemKey,
    rangeExtractor,
  });
  useEffect(
    () =>
      controller?.registerReveal(store, (nodeId) => {
        const index = visible.findIndex((node) => node.id === nodeId);
        if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' });
      }),
    [controller, store, virtualizer, visible]
  );
  return (
    <div
      ref={outlineRef}
      role="tree"
      style={{ position: 'relative', height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          ref={virtualizer.measureElement}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${item.start - scrollMargin}px)`,
          }}
        >
          <TodayRow store={store} {...rowState(controller, store, visible, item.index)} />
        </div>
      ))}
    </div>
  );
}

const EMPTY_ROWS = { visible: [], isEmpty: true, layout: {} };

/** A single-line row's height (the row's minimum). */
const TODAY_ROW_HEIGHT = 28;
const estimateSize = () => TODAY_ROW_HEIGHT;

const TodayRow = memo(function TodayRow(props: {
  node: TodayNodeView | null;
  store: TodayPageStore;
  active: boolean;
  selected: boolean;
  joinsPrevious?: boolean;
  joinsNext?: boolean;
  /** The zoomed node's own row: its text as the view's title, without fold or bullet. */
  title?: boolean;
}) {
  const { t } = useTranslation();
  const { node, store, active, selected, title = false } = props;
  const controller = useContext(TodayEditorContext);
  const moreAtEnd = useContext(TodayMoreAtEndContext);
  const done = node?.todo === 'done';
  const blank = !!node && !node.text.trim() && !node.hasChildren && !node.todo;
  return (
    <div
      {...stylex.props(
        stylex.defaultMarker(),
        styles.row,
        title && styles.rowTitle,
        selected && styles.blockSelected,
        selected && props.joinsPrevious && styles.joinTop,
        selected && props.joinsNext && styles.joinBottom
      )}
      style={{
        paddingInlineStart: (node?.depth ?? 0) * TODAY_INDENT_PX,
        paddingInlineEnd: moreAtEnd && !title ? 18 : undefined,
      }}
      role="treeitem"
      aria-selected={selected || undefined}
      aria-expanded={node?.hasChildren ? !node.collapsed : undefined}
      data-today-node={node?.id}
      onPointerDown={(event) => {
        // The gaps between controls are inert: they must not take focus from the editor.
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      {title || !node ? null : (
        <button
          type="button"
          {...stylex.props(styles.more)}
          style={moreAtEnd ? { right: 0 } : { left: node.depth * TODAY_INDENT_PX - 16 }}
          aria-label={t('today.nodeMenu', 'Node actions')}
          aria-haspopup="menu"
          tabIndex={-1}
          data-today-more
          onPointerDown={(event) => event.preventDefault()}
          onClick={(event) => controller?.onNodeMenu?.(store, node.id, event.currentTarget)}
        >
          <MoreHorizontal size={14} strokeWidth={2} />
        </button>
      )}
      {title ? null : (
        <button
          type="button"
          {...stylex.props(
            styles.fold,
            active && styles.foldShown,
            !node?.hasChildren && styles.foldHidden
          )}
          aria-label={
            node?.collapsed ? t('today.expand', 'Expand') : t('today.collapse', 'Collapse')
          }
          tabIndex={-1}
          onClick={() => {
            if (!node) return;
            // Folding is not an undo step.
            store.outline.setCollapsed(node.id, !node.collapsed);
          }}
        >
          <ChevronRight
            size={12}
            {...stylex.props(node?.hasChildren && !node.collapsed && styles.foldOpen)}
          />
        </button>
      )}
      {title ? null : (
        <span
          {...stylex.props(styles.bullet, styles.handle)}
          data-today-bullet
          onPointerDown={(event) => {
            if (!controller || !node || event.button !== 0) return;
            event.preventDefault();
            controller.beginNodeDrag(store, node.id, event.currentTarget, event);
          }}
          onContextMenu={(event) => {
            if (!controller?.onNodeMenu || !node) return;
            event.preventDefault();
            controller.onNodeMenu(store, node.id, { x: event.clientX, y: event.clientY });
          }}
        >
          <span {...stylex.props(styles.halo)}>
            <span
              {...stylex.props(
                styles.dot,
                node?.collapsed && styles.dotFolded,
                blank && !active && !selected && styles.dotQuiet
              )}
              data-today-dot={blank && !active && !selected ? 'quiet' : undefined}
            />
          </span>
        </span>
      )}
      {node?.todo ? (
        <span
          {...stylex.props(styles.check)}
          role="checkbox"
          aria-checked={done}
          aria-label={t('today.todo.done', 'Done')}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => controller?.toggleDone(store, node.id)}
        >
          <span {...stylex.props(styles.checkBox, done && styles.checkBoxDone)}>
            {done ? <Check size={10} strokeWidth={3.5} /> : null}
          </span>
        </span>
      ) : null}
      {active && controller ? (
        <>
          <div
            key="editor"
            ref={controller.attachRoot}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            role="textbox"
            aria-multiline
            {...stylex.props(
              styles.text,
              styles.editable,
              title && styles.titleText,
              done && styles.textDone
            )}
            onPointerDown={(event) => {
              if (!node || event.button !== 0 || event.metaKey || event.ctrlKey) return;
              if (event.shiftKey || event.altKey || event.detail > 1) return;
              controller.pointerDownInEditor(store, node.id, event.currentTarget);
            }}
          />
          <TodayMentionDecorators controller={controller} />
        </>
      ) : (
        <div
          key="static"
          {...stylex.props(
            styles.text,
            title && styles.titleText,
            (!node || !node.text) && styles.placeholder,
            done && styles.textDone
          )}
          onPointerDown={(event) => {
            if (!controller || event.button !== 0 || event.metaKey || event.ctrlKey) return;
            if (event.altKey) return;
            event.preventDefault();
            if (!node) controller.startPage(store);
            else controller.pointerDown(store, node.id, event.currentTarget, event);
          }}
        >
          {node ? <TodayStaticText node={node} /> : t('today.empty', 'Write something…')}
          {node?.text.endsWith('\n') ? '\n' : null}
        </div>
      )}
    </div>
  );
});

/** A node's text as the editor would show it: text runs and mentions. */
function TodayStaticText(props: { node: TodayNodeView }) {
  const { text, mentions } = props.node;
  if (!text) return '\u200b';
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const mention of mentions) {
    if (mention.start > cursor) parts.push(text.slice(cursor, mention.start));
    parts.push(<TodayMention key={mention.start} mention={mention} />);
    cursor = mention.start + 1;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.map((part, index) => <Fragment key={index}>{part}</Fragment>);
}

/** Acquire the page while its section is within ~1.5 screens of the viewport. */
function useNearViewportPage(
  ref: React.RefObject<HTMLElement | null>,
  cache: TodayPageStoreCache,
  docId: string
): { store: TodayPageStore | undefined; failed: boolean; retry: () => void } {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  const [store, setStore] = useState<TodayPageStore | undefined>(() => cache.peek(docId));
  const [failed, setFailed] = useState(false);
  // Bumped by Retry: a failed open is not cached, so acquiring again starts over.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: '150% 0px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  useEffect(() => {
    if (!near) return undefined;
    let cancelled = false;
    let held = false;
    setFailed(false);
    cache.acquire(docId).then(
      (acquired) => {
        if (cancelled) {
          cache.releaseRef(docId);
          return;
        }
        held = true;
        setStore(acquired);
      },
      (error: unknown) => {
        console.warn('Today page failed to open', { docId, error });
        if (!cancelled) setFailed(true);
      }
    );
    return () => {
      cancelled = true;
      setStore(undefined);
      if (held) cache.releaseRef(docId);
    };
  }, [attempt, cache, docId, near]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { store, failed, retry };
}
