import type { Meta, StoryObj } from '@storybook/react';
import { LoroDoc } from 'loro-crdt';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@lody/ui/button';
import {
  getTodayDocId,
  openTodayOutline,
  parseTodayPasteText,
  type TodayDate,
  type TodayNodeId,
} from '@lody/shared';
import { TodayEditorContext } from '@/components/today/editor/today-editor-context';
import { TodayEditorController } from '@/components/today/editor/today-editor-controller';
import { TodayDaySection } from '@/components/today/today-day-section';
import {
  captureScrollAnchor,
  restoreScrollAnchor,
  type TodayScrollAnchor,
  TodayFocusCrumbs,
  TodayNodeActions,
  TodayOutlineSurface,
  TodayToolbar,
} from '@/components/today/today-view';
import { createTodayPageStoreCache } from '@/providers/today-page-store-cache';

const USER = 'demo-user';
const TODAY = '2026-11-22' as TodayDate;
const EARLIER = '2026-11-21' as TodayDate;
const PAGES: Record<string, string> = {
  [getTodayDocId(USER, TODAY)]: [
    'Launch the focus view',
    '  Design',
    '    Breadcrumb in the top-left',
    '    Hover menu beside the bullet',
    '  Build',
    '    Zoom into a node',
    '      Keep the caret inside',
    '    Restore the stream scroll',
    'Reply to the plugin thread',
  ].join('\n'),
  [getTodayDocId(USER, EARLIER)]: 'Ideas\n  Pin Today next to the sidebar\nRead the outliner notes',
};

type Target = { date?: TodayDate; focus?: string };

/** The focus view's navigation, as the Today page drives it, over in-memory pages. */
function FocusHarness(props: { initial?: Target }) {
  const cache = useMemo(
    () =>
      createTodayPageStoreCache({
        releaseDelayMs: 60_000,
        idleCap: 4,
        retryDelayMs: () => 1_000,
        setTimer: (callback, ms) => {
          const timer = setTimeout(callback, ms);
          return () => clearTimeout(timer);
        },
        repo: {
          openDoc: async (docId) => {
            const doc = new LoroDoc();
            const seed = PAGES[docId];
            if (seed)
              openTodayOutline(doc).paste({ kind: 'page-start' }, parseTodayPasteText(seed));
            return {
              doc,
              joinRoom: async () => ({
                room: { unsubscribe: () => {} },
                synced: Promise.resolve(),
              }),
            };
          },
          isRegistered: async (docId) => docId in PAGES,
          upsertDocMeta: async () => {},
          unloadDoc: async () => {},
          observeDocs: () => ({ docIds: Object.keys(PAGES), unsubscribe: () => {} }),
        },
      }),
    []
  );
  const [target, setTargetState] = useState<Target>(props.initial ?? {});
  const streamAnchor = useRef<TodayScrollAnchor | null>(null);
  const setTarget = (next: Target) => {
    if (!target.focus && next.focus) {
      streamAnchor.current = captureScrollAnchor(controller?.getSurface() ?? null);
    }
    setTargetState(next);
  };
  const [controller, setController] = useState<TodayEditorController | null>(null);
  useEffect(() => {
    const created = new TodayEditorController(cache);
    setController(created);
    return () => created.dispose();
  }, [cache]);
  const focusDate = target.focus ? (target.date ?? TODAY) : null;
  const zoomRoot = target.focus && target.focus !== 'day' ? (target.focus as TodayNodeId) : null;
  useEffect(() => {
    if (!controller) return;
    controller.setFocus(focusDate ? { date: focusDate, rootId: zoomRoot } : null);
    controller.onZoom = (store, nodeId) => setTarget({ date: store.date, focus: nodeId });
    controller.onZoomOut = () => {
      if (!focusDate) return;
      if (!zoomRoot) return setTarget({});
      const page = cache.peek(getTodayDocId(USER, focusDate));
      const parent = page?.outline.getNode(zoomRoot)?.parentId;
      setTarget({ date: focusDate, focus: parent ?? 'day' });
    };
  }, [cache, controller, focusDate, zoomRoot]);
  useLayoutEffect(() => {
    if (focusDate || !streamAnchor.current) return undefined;
    const anchor = streamAnchor.current;
    streamAnchor.current = null;
    return restoreScrollAnchor(controller?.getSurface() ?? null, anchor);
  }, [controller, focusDate]);
  const days = focusDate ? [focusDate] : [TODAY, EARLIER];
  return (
    <TodayEditorContext.Provider value={controller}>
      <div style={{ maxWidth: 720, height: 360, display: 'flex', flexDirection: 'column' }}>
        <TodayToolbar
          surface="pinned"
          interactiveTitle={!!focusDate}
          title={
            focusDate ? (
              <TodayFocusCrumbs
                page={() => cache.peek(getTodayDocId(USER, focusDate))}
                date={focusDate}
                zoomRoot={zoomRoot}
                rootLabel="Today"
                onStream={() => setTarget({})}
                onFocus={(focus) => setTarget({ date: focusDate, focus })}
              />
            ) : null
          }
        >
          <Button variant="ghost" size="small" icon aria-label="More">
            <MoreHorizontal size={16} strokeWidth={1.5} />
          </Button>
        </TodayToolbar>
        <TodayOutlineSurface controller={controller}>
          {days.map((date, index) => (
            <TodayDaySection
              key={date}
              cache={cache}
              userId={USER}
              date={date}
              today={TODAY}
              isTop={index === 0}
              onEmptyChange={() => {}}
              zoomRoot={zoomRoot}
              onOpenDay={focusDate ? undefined : (day) => setTarget({ date: day, focus: 'day' })}
            />
          ))}
        </TodayOutlineSurface>
        <TodayNodeActions pinned={false} />
      </div>
    </TodayEditorContext.Provider>
  );
}

const meta: Meta<typeof FocusHarness> = {
  title: 'Today/Focus view',
  component: FocusHarness,
};
export default meta;

/** The stream: click a date to open that day alone, a bullet to zoom in, "⋯" for its menu. */
export const Stream: StoryObj<typeof FocusHarness> = {};

/** One day alone, under "Today › 2026-11-21". */
export const DayFocused: StoryObj<typeof FocusHarness> = {
  args: { initial: { date: EARLIER, focus: 'day' } },
};
