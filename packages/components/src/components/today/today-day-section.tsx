import * as stylex from '@stylexjs/stylex';
import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { getTodayDocId, type TodayDate, type TodayNodeView } from '@lody/shared';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { useTodayEditor } from './editor/today-editor-context';
import { TodaySessionLabel } from './today-session-node';
import type { TodayPageStore } from '@/lib/today/today-page-store';
import type { TodayPageStoreCache } from '../../providers/today-page-store-cache';
import { formatTodayHeading } from './today-stream';

/** Indentation per outline level. */
const TODAY_INDENT_PX = 22;

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
    // Hang the fold toggle in the margin so the bullet dot lines up with the
    // date heading: toggle 16 + gap 4 + the dot's inset in its 16px box (5).
    marginInlineStart: -25,
  },
  fold: {
    width: 16,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: colors.tertiaryLabel,
    background: 'none',
    borderWidth: 0,
    padding: 0,
    cursor: 'pointer',
    flexShrink: 0,
  },
  foldHidden: { visibility: 'hidden' },
  foldOpen: { transform: 'rotate(90deg)' },
  bullet: {
    width: 16,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  dot: { width: 6, height: 6, borderRadius: radius.full, backgroundColor: colors.secondaryLabel },
  dotFolded: { boxShadow: `0 0 0 4px ${colors.selectedFill}` },
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
  editable: { outline: 'none', cursor: 'text' },
  handle: { cursor: 'grab', touchAction: 'none' },
  blockSelected: { backgroundColor: `color-mix(in srgb, ${colors.accent} 14%, transparent)` },
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
  onEmpty: (date: TodayDate) => void;
}) {
  const { t, i18n } = useTranslation();
  const ref = useRef<HTMLElement | null>(null);
  const store = useNearViewportPage(ref, props.cache, getTodayDocId(props.userId, props.date));
  const heading = formatTodayHeading(props.date, props.today, i18n.language);
  return (
    <section ref={ref} {...stylex.props(styles.section)} data-today-date={props.date}>
      <h2 {...stylex.props(styles.header)}>
        {heading.isToday ? t('today.title', 'Today') : heading.date}
        <span {...stylex.props(styles.headerMeta)}>{heading.meta}</span>
      </h2>
      {store ? (
        <TodayStaticOutline store={store} isTop={props.isTop} onEmpty={props.onEmpty} />
      ) : (
        <div {...stylex.props(styles.outline)} />
      )}
    </section>
  );
}

function TodayStaticOutline(props: {
  store: TodayPageStore;
  isTop: boolean;
  onEmpty: (date: TodayDate) => void;
}) {
  const { store, isTop, onEmpty } = props;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const controller = useTodayEditor();
  useEffect(() => controller?.registerDay(store.date, store), [controller, store]);
  useEffect(() => {
    if (isTop) return undefined;
    let cancelled = false;
    void store.synced.then(() => {
      if (!cancelled && store.getSnapshot().isEmpty) onEmpty(store.date);
    });
    return () => {
      cancelled = true;
    };
  }, [isTop, onEmpty, store]);

  if (snapshot.visible.length === 0) {
    return (
      <div {...stylex.props(styles.outline)}>
        <TodayRow node={null} store={store} />
      </div>
    );
  }
  return (
    <div {...stylex.props(styles.outline)} role="tree">
      {snapshot.visible.map((node) => (
        <TodayRow key={node.id} node={node} store={store} />
      ))}
    </div>
  );
}

function TodayRow(props: { node: TodayNodeView | null; store: TodayPageStore }) {
  const { t } = useTranslation();
  const { node, store } = props;
  const controller = useTodayEditor();
  const active = !!node && !!controller?.isActive(store, node.id);
  const selected = !!node && !!controller?.isBlockSelected(store, node.id);
  return (
    <div
      {...stylex.props(styles.row, selected && styles.blockSelected)}
      style={{ paddingInlineStart: (node?.depth ?? 0) * TODAY_INDENT_PX }}
      role="treeitem"
      aria-selected={selected || undefined}
      aria-expanded={node?.hasChildren ? !node.collapsed : undefined}
      data-today-node={node?.id}
    >
      <button
        type="button"
        {...stylex.props(
          styles.fold,
          !node?.hasChildren && styles.foldHidden,
          node?.hasChildren && !node.collapsed && styles.foldOpen
        )}
        aria-label={node?.collapsed ? t('today.expand', 'Expand') : t('today.collapse', 'Collapse')}
        tabIndex={-1}
        onClick={() => {
          if (!node) return;
          store.undo.structural(() => store.outline.setCollapsed(node.id, !node.collapsed));
        }}
      >
        <ChevronRight size={12} />
      </button>
      <span
        {...stylex.props(styles.bullet, styles.handle)}
        onPointerDown={(event) => {
          if (!controller || !node || event.button !== 0) return;
          event.preventDefault();
          controller.beginNodeDrag(store, node.id, event.currentTarget, event);
        }}
      >
        <span {...stylex.props(styles.dot, node?.collapsed && styles.dotFolded)} />
      </span>
      {node?.kind === 'session' && node.sessionId ? (
        <div
          key="session"
          {...stylex.props(styles.text)}
          onPointerDown={(event) => {
            if (!controller || event.button !== 0) return;
            event.preventDefault();
            controller.pointerDown(store, node.id, event.currentTarget, event);
          }}
        >
          <TodaySessionLabel
            sessionId={node.sessionId}
            onOpen={(event) => controller?.onOpenSession?.(node.sessionId!, event)}
          />
        </div>
      ) : active && controller ? (
        <div
          key="editor"
          ref={controller.attachRoot}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          role="textbox"
          aria-multiline
          {...stylex.props(styles.text, styles.editable)}
        />
      ) : (
        <div
          key="static"
          {...stylex.props(styles.text, (!node || !node.text) && styles.placeholder)}
          onPointerDown={(event) => {
            if (!controller || event.button !== 0 || event.metaKey || event.ctrlKey) return;
            if (event.altKey) return;
            event.preventDefault();
            if (!node) controller.startPage(store);
            else controller.pointerDown(store, node.id, event.currentTarget, event);
          }}
        >
          {node ? node.text || '\u200b' : t('today.empty', 'Write something…')}
          {node?.text.endsWith('\n') ? '\n' : null}
        </div>
      )}
    </div>
  );
}

/** Acquire the page while its section is within ~1.5 screens of the viewport. */
function useNearViewportPage(
  ref: React.RefObject<HTMLElement | null>,
  cache: TodayPageStoreCache,
  docId: string
): TodayPageStore | undefined {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  const [store, setStore] = useState<TodayPageStore | undefined>(() => cache.peek(docId));
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
    void cache.acquire(docId).then((acquired) => {
      if (cancelled) {
        cache.releaseRef(docId);
        return;
      }
      held = true;
      setStore(acquired);
    });
    return () => {
      cancelled = true;
      setStore(undefined);
      if (held) cache.releaseRef(docId);
    };
  }, [cache, docId, near]);
  return store;
}
