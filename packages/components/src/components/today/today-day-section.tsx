import * as stylex from '@stylexjs/stylex';
import { Check, ChevronRight } from 'lucide-react';
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { getTodayDocId, type TodayDate, type TodayNodeView } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { useTodayEditor } from './editor/today-editor-context';
import { TodayMentionDecorators } from './editor/today-mention-decorators';
import { TODAY_INDENT_PX } from './editor/today-editor-controller';
import { TodayMention } from './today-session-mention';
import type { TodayPageStore } from '@/lib/today/today-page-store';
import type { TodayPageStoreCache } from '../../providers/today-page-store-cache';
import { formatTodayHeading } from './today-stream';
import { todayOutline } from './outline.stylex';

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
  // Same size as the date: weight and colour carry the hierarchy, not a smaller font.
  headerMeta: { fontWeight: 400, color: colors.secondaryLabel },
  outline: { display: 'flex', flexDirection: 'column', minHeight: 28 },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[1],
    minHeight: 28,
    borderRadius: radius.mini,
    // Hang the fold toggle in the margin (`todayOutline.foldOverhang`).
    marginInlineStart: `calc(-1 * ${todayOutline.foldOverhang})`,
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
  // The bullet is a control (click: select the node and show its actions; drag:
  // move it): a halo under the pointer says so, as Logseq and Workflowy do.
  halo: {
    width: 16,
    height: 16,
    borderRadius: radius.full,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    // Above the bullet's hit area, so the circle itself takes the hover.
    position: 'relative',
    pointerEvents: 'auto',
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    transitionProperty: 'background-color',
    transitionDuration: '100ms',
  },
  dot: { width: 6, height: 6, borderRadius: radius.full, backgroundColor: colors.secondaryLabel },
  dotFolded: { boxShadow: `0 0 0 4px ${colors.selectedFill}` },
  // An empty line shows no dot until its row is hovered (or it is being
  // edited or selected), so blank lines read as space, not as items.
  dotQuiet: {
    opacity: { default: 0, [stylex.when.ancestor(':hover')]: 1 },
    transitionProperty: 'opacity',
    transitionDuration: '100ms',
  },
  // A to-do's checkbox sits between the bullet and the text, so the bullet
  // stays the one handle every node has.
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
  // Done reads like a settled conversation's mention: struck and dimmed.
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
}) {
  const { t, i18n } = useTranslation();
  const ref = useRef<HTMLElement | null>(null);
  const page = useNearViewportPage(ref, props.cache, getTodayDocId(props.userId, props.date));
  const heading = formatTodayHeading(props.date, props.today, i18n.language);
  return (
    <section ref={ref} {...stylex.props(styles.section)} data-today-date={props.date}>
      <h2 {...stylex.props(styles.header)}>
        {heading.isToday ? t('today.title', 'Today') : heading.date}
        <span {...stylex.props(styles.headerMeta)}>{heading.meta}</span>
      </h2>
      {page.store ? (
        <TodayStaticOutline
          store={page.store}
          isTop={props.isTop}
          onEmptyChange={props.onEmptyChange}
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

  if (snapshot.visible.length === 0) {
    return (
      <div {...stylex.props(styles.outline)}>
        <TodayRow node={null} store={store} />
      </div>
    );
  }
  return (
    <div {...stylex.props(styles.outline)} role="tree">
      {snapshot.visible.map((node, index) => (
        <TodayRow
          key={node.id}
          node={node}
          store={store}
          // A run of selected rows reads as one block: only its ends are rounded.
          joinsPrevious={
            index > 0 && !!controller?.isBlockSelected(store, snapshot.visible[index - 1]!.id)
          }
          joinsNext={
            index < snapshot.visible.length - 1 &&
            !!controller?.isBlockSelected(store, snapshot.visible[index + 1]!.id)
          }
        />
      ))}
    </div>
  );
}

function TodayRow(props: {
  node: TodayNodeView | null;
  store: TodayPageStore;
  joinsPrevious?: boolean;
  joinsNext?: boolean;
}) {
  const { t } = useTranslation();
  const { node, store } = props;
  const controller = useTodayEditor();
  const active = !!node && !!controller?.isActive(store, node.id);
  const selected = !!node && !!controller?.isBlockSelected(store, node.id);
  const done = node?.todo === 'done';
  // Nothing to mark yet: no text, no children, not a to-do.
  const blank = !!node && !node.text.trim() && !node.hasChildren && !node.todo;
  return (
    <div
      {...stylex.props(
        stylex.defaultMarker(),
        styles.row,
        selected && styles.blockSelected,
        selected && props.joinsPrevious && styles.joinTop,
        selected && props.joinsNext && styles.joinBottom
      )}
      style={{ paddingInlineStart: (node?.depth ?? 0) * TODAY_INDENT_PX }}
      role="treeitem"
      aria-selected={selected || undefined}
      aria-expanded={node?.hasChildren ? !node.collapsed : undefined}
      data-today-node={node?.id}
      onPointerDown={(event) => {
        // The gaps between controls are inert: they must not take focus from the editor.
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      <button
        type="button"
        {...stylex.props(
          styles.fold,
          active && styles.foldShown,
          !node?.hasChildren && styles.foldHidden
        )}
        aria-label={node?.collapsed ? t('today.expand', 'Expand') : t('today.collapse', 'Collapse')}
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
      <span
        {...stylex.props(styles.bullet, styles.handle)}
        data-today-bullet
        onPointerDown={(event) => {
          if (!controller || !node || event.button !== 0) return;
          event.preventDefault();
          controller.beginNodeDrag(store, node.id, event.currentTarget, event);
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
      {node?.todo ? (
        <span
          {...stylex.props(styles.check)}
          role="checkbox"
          aria-checked={done}
          aria-label={t('today.todo.done', 'Done')}
          // The press must not take focus (and the caret) from the editor.
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
            {...stylex.props(styles.text, styles.editable, done && styles.textDone)}
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
}

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
