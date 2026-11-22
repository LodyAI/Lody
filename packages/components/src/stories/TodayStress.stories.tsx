import type { Meta, StoryObj } from '@storybook/react';
import { LoroDoc } from 'loro-crdt';
import { useEffect, useMemo, useState } from 'react';
import { getTodayDocId, openTodayOutline, type TodayDate, type TodayFragment } from '@lody/shared';
import { TodayEditorContext } from '@/components/today/editor/today-editor-context';
import { TodayEditorController } from '@/components/today/editor/today-editor-controller';
import { TodayDaySection } from '@/components/today/today-day-section';
import { TodayOutlineSurface } from '@/components/today/today-view';
import { createTodayPageStoreCache } from '@/providers/today-page-store-cache';

const USER = 'stress-user';
const TODAY = '2026-11-22' as TodayDate;
const WORDS =
  'sync retry cache join room stream fold bullet node caret select drag drop undo redo merge split indent outdent mention status session agent prompt deterministic 同步 重试 缓存 节点 光标 拖动 撤销 合并 缩进 会话 提示词 大纲 性能 虚拟滚动'.split(
    ' '
  );

/** Deterministic PRNG, so every run measures the same outline. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` nodes, at most `maxDepth` levels, about `chars` characters of text in total. */
export function buildStressOutline(count: number, maxDepth: number, chars: number) {
  const random = mulberry32(7);
  const average = chars / count;
  const roots: TodayFragment[] = [];
  const stack: TodayFragment[] = [];
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const depth = Math.min(maxDepth - 1, Math.floor(random() * (stack.length + 1.6)));
    stack.length = Math.min(stack.length, depth);
    // Mostly short lines, a few long enough to wrap several times.
    const target = random() < 0.08 ? average * 6 : average * (0.4 + random() * 0.6);
    let text = '';
    while (text.length < target) text += `${WORDS[Math.floor(random() * WORDS.length)]} `;
    text = text.trimEnd();
    total += text.length;
    const fragment: TodayFragment = { text, children: [] };
    (stack.at(-1)?.children ?? roots).push(fragment);
    stack.push(fragment);
  }
  return { roots, total };
}

function StressOutline(props: { count: number; maxDepth: number; chars: number }) {
  const { count, maxDepth, chars } = props;
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
          openDoc: async () => {
            const doc = new LoroDoc();
            const { roots, total } = buildStressOutline(count, maxDepth, chars);
            const started = performance.now();
            openTodayOutline(doc).paste({ kind: 'page-start' }, roots);
            Object.assign(window, {
              __todayStressSeed: { total, nodes: count, buildMs: performance.now() - started },
            });
            return {
              doc,
              joinRoom: async () => ({
                room: { unsubscribe: () => {} },
                synced: Promise.resolve(),
              }),
            };
          },
          isRegistered: async () => true,
          upsertDocMeta: async () => {},
          unloadDoc: async () => {},
          observeDocs: () => ({ docIds: [getTodayDocId(USER, TODAY)], unsubscribe: () => {} }),
        },
      }),
    [chars, count, maxDepth]
  );
  const [controller, setController] = useState<TodayEditorController | null>(null);
  useEffect(() => {
    const created = new TodayEditorController(cache);
    setController(created);
    Object.assign(window, { __todayStress: { cache, controller: created } });
    return () => created.dispose();
  }, [cache]);
  return (
    <TodayEditorContext.Provider value={controller}>
      <div style={{ maxWidth: 720, height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <TodayOutlineSurface controller={controller}>
          <TodayDaySection
            cache={cache}
            userId={USER}
            date={TODAY}
            today={TODAY}
            isTop
            onEmptyChange={() => {}}
          />
        </TodayOutlineSurface>
      </div>
    </TodayEditorContext.Provider>
  );
}

const meta: Meta<typeof StressOutline> = {
  title: 'Today/Stress',
  component: StressOutline,
  parameters: { layout: 'fullscreen' },
};
export default meta;

/** The performance target: 30,000 nodes, 7 levels, about a million characters. */
export const ThirtyThousandNodes: StoryObj<typeof StressOutline> = {
  args: { count: 30_000, maxDepth: 7, chars: 1_000_000 },
};

/** A smaller page for comparison. */
export const ThreeThousandNodes: StoryObj<typeof StressOutline> = {
  args: { count: 3_000, maxDepth: 7, chars: 100_000 },
};
