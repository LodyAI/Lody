import type { Meta, StoryObj } from '@storybook/react';
import { LoroDoc } from 'loro-crdt';
import { useEffect, useMemo, useState } from 'react';
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
              joinRoom: async () => ({ room: { unsubscribe: () => {} }, synced: true }),
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

function DayStream(props: { dates: TodayDate[] }) {
  const cache = useDemoCache();
  const [controller, setController] = useState<TodayEditorController | null>(null);
  useEffect(() => {
    const created = new TodayEditorController(cache);
    setController(created);
    return () => created.dispose();
  }, [cache]);
  return (
    <TodayEditorContext.Provider value={controller}>
      <div style={{ maxWidth: 720, height: 640, display: 'flex', flexDirection: 'column' }}>
        <TodayOutlineSurface controller={controller}>
          {props.dates.map((date, index) => (
            <TodayDaySection
              key={date}
              cache={cache}
              userId={USER}
              date={date}
              today={TODAY}
              isTop={index === 0}
              onEmpty={() => {}}
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
};
export default meta;

export const TodayWithEarlierDay: StoryObj<typeof DayStream> = {
  args: { dates: [TODAY, '2026-11-18' as TodayDate] },
};

export const EmptyToday: StoryObj<typeof DayStream> = {
  args: { dates: ['2026-11-21' as TodayDate] },
};
