import { colors as uiColors } from '@lody/ui/tokens/colors.stylex';
import { text as uiText } from '@lody/ui/tokens/scales.stylex';
import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { LoroDoc } from 'loro-crdt';
import { useEffect, useMemo, useState } from 'react';
import { useSetAtom } from 'jotai';
import { CalendarDays, MoreHorizontal, Pin } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Toggle } from '@lody/ui/toggle';
import { sidebarCollapsedAtom } from '@/atoms/sidebar-state';
import { TodayPinnedCard } from '@/components/today/today-pinned-column';
import { TodayToolbar } from '@/components/today/today-view';
import { WorkspaceCard } from '@/components/workspace-frame';
import { getTodayDocId, openTodayOutline, parseTodayPasteText, type TodayDate } from '@lody/shared';
import { TodayEditorContext } from '@/components/today/editor/today-editor-context';
import { TodayEditorController } from '@/components/today/editor/today-editor-controller';
import { TodayDaySection } from '@/components/today/today-day-section';
import { TodayOutlineSurface } from '@/components/today/today-view';
import { createTodayPageStoreCache } from '@/providers/today-page-store-cache';

const USER = 'demo-user';
const TODAY = '2026-11-20' as TodayDate;
const PAGES: Record<string, string> = {
  [getTodayDocId(USER, TODAY)]:
    'Release checklist\n  Check the nightly build\n  Draft notes\nPrompt for later\n  Refactor the sync retry so a failed join never caches\n  Keep the test deterministic',
  [getTodayDocId(USER, '2026-11-18' as TodayDate)]: 'Ideas\n  Pin Today next to the sidebar',
};

/** In-memory pages so the stream renders without a workspace runtime. */
function useDemoCache() {
  return useMemo(
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
}

function DayStream(props: {
  dates: TodayDate[];
  /** Fill the canvas, as the Today page does in a wide main area. */
  wide?: boolean;
  fullWidth?: boolean;
  placement?: 'page' | 'pinned' | 'pinnedAtWindowEdge';
}) {
  const cache = useDemoCache();
  const [controller, setController] = useState<TodayEditorController | null>(null);
  useEffect(() => {
    const created = new TodayEditorController(cache);
    setController(created);
    return () => created.dispose();
  }, [cache]);
  return (
    <TodayEditorContext.Provider value={controller}>
      <div
        style={{
          maxWidth: props.wide ? undefined : 720,
          height: props.placement === 'pinnedAtWindowEdge' ? '100%' : 640,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <TodayOutlineSurface
          controller={controller}
          fullWidth={props.fullWidth}
          placement={props.placement}
        >
          {props.dates.map((date, index) => (
            <TodayDaySection
              key={date}
              cache={cache}
              userId={USER}
              date={date}
              today={TODAY}
              isTop={index === 0}
              onEmptyChange={() => {}}
            />
          ))}
        </TodayOutlineSurface>
      </div>
    </TodayEditorContext.Provider>
  );
}

const meta: Meta<typeof DayStream> = {
  title: 'Today/Day stream',
  component: DayStream,
  excludeStories: ['PinnedTodayToolbar'],
};
export default meta;

export const TodayWithEarlierDay: StoryObj<typeof DayStream> = {
  args: { dates: [TODAY, '2026-11-18' as TodayDate] },
};

export const EmptyToday: StoryObj<typeof DayStream> = {
  args: { dates: ['2026-11-21' as TodayDate] },
};

/** A wide main area: the stream keeps its readable column, centred. */
export const WideWindow: StoryObj<typeof DayStream> = {
  args: { dates: [TODAY, '2026-11-18' as TodayDate], wide: true },
};

/** The same with the page's Full width preference on. */
export const WideWindowFullWidth: StoryObj<typeof DayStream> = {
  args: { dates: [TODAY, '2026-11-18' as TodayDate], wide: true, fullWidth: true },
};

export function PinnedTodayToolbar() {
  return (
    <TodayToolbar surface="pinned" title={null}>
      <Button variant="ghost" size="small" icon aria-label="Pick a date">
        <CalendarDays size={16} strokeWidth={1.5} />
      </Button>
      <Toggle size="small" icon pressed aria-label="Pin to sidebar">
        <Pin size={16} strokeWidth={1.5} fill="none" />
      </Toggle>
      <Button variant="ghost" size="small" icon aria-label="More">
        <MoreHorizontal size={16} strokeWidth={1.5} />
      </Button>
    </TodayToolbar>
  );
}

/** Draws where macOS puts the traffic lights (close button centred at 23, 23). */
function TrafficLights() {
  return (
    <div
      aria-hidden
      style={{ position: 'fixed', top: 16, left: 16, display: 'flex', gap: 8, zIndex: 100 }}
    >
      {['#ff5f57', '#febc2e', '#28c840'].map((color) => (
        <span key={color} style={{ width: 14, height: 14, borderRadius: 7, background: color }} />
      ))}
    </div>
  );
}

/** Desktop macOS with the navigation sidebar hidden, as the shell renders it. */
function PinnedAtWindowEdge() {
  const [ready] = useState(() => {
    window.__LODY_ELECTRON__ = true;
    window.__LODY_PLATFORM__ = { ...window.__LODY_PLATFORM__, os: 'darwin' } as never;
    return true;
  });
  const setCollapsed = useSetAtom(sidebarCollapsedAtom);
  useEffect(() => {
    setCollapsed(true);
    return () => {
      window.__LODY_ELECTRON__ = undefined as never;
    };
  }, [setCollapsed]);
  if (!ready) return null;
  return (
    <div {...stylex.props(themeStyles.row)}>
      <TrafficLights />
      <TodayPinnedCard width={360} anchored={false} label="Today">
        <PinnedTodayToolbar />
        <DayStream dates={[TODAY, '2026-11-18' as TodayDate]} placement="pinnedAtWindowEdge" />
      </TodayPinnedCard>
      <WorkspaceCard anchored>
        <div {...stylex.props(themeStyles.hint)}>Conversation</div>
      </WorkspaceCard>
    </div>
  );
}

/**
 * Pinned with the sidebar hidden: Today is the leftmost surface, carries the
 * sidebar toggle and Back/Forward, and its fold toggles line up under the
 * close button.
 */
export const PinnedSidebarHidden: StoryObj<typeof DayStream> = {
  args: { dates: [TODAY] },
  parameters: { layout: 'fullscreen' },
  render: () => <PinnedAtWindowEdge />,
};

const themeStyles = stylex.create({
  row: { display: 'flex', height: '100dvh', width: '100%', overflow: 'hidden', backgroundColor: uiColors.secondaryBackground, color: uiColors.label },
  hint: { padding: 'calc(var(--spacing) * 6)', fontSize: uiText.subheadlineSize, lineHeight: uiText.subheadlineLeading, color: uiColors.secondaryLabel },
});
