import type { Meta, StoryObj } from '@storybook/react';
import { LoroDoc } from 'loro-crdt';
import { useMemo } from 'react';
import { getTodayDocId, openTodayOutline, parseTodayPasteText, type TodayDate } from '@lody/shared';
import { TodayDaySection } from '@/components/today/today-day-section';
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
            return { doc, joinRoom: async () => ({ unsubscribe: () => {} }) };
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
  return (
    <div style={{ maxWidth: 720, padding: 24 }}>
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
    </div>
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
