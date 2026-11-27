import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Spacing around Today's conversation mentions, measured in real layout on the
 * `Today/With conversations` story: a mention is spaced like a word, and a row
 * keeps every position when the editor mounts on it.
 */
const STORY = '/iframe.html?id=today-with-conversations--default&viewMode=story';

type Layout = {
  /** Title edges of each conversation mention, in document order. */
  titles: { left: number; right: number; chipLeft: number }[];
  /** Edges of each probe, found in the row's text outside mentions. */
  probes: Record<string, { left: number; right: number } | null>;
};

function measure(row: Locator, probes: string[]): Promise<Layout> {
  return row.evaluate((element, probes) => {
    const titles = [...element.querySelectorAll('[data-today-session]')].map((chip) => {
      const title = chip.querySelector('[role="button"]')!.getBoundingClientRect();
      return { left: title.left, right: title.right, chipLeft: chip.getBoundingClientRect().left };
    });
    const find = (probe: string) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (node.parentElement?.closest('[data-today-mention]')) continue;
        const at = node.data.indexOf(probe);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + probe.length);
        const rect = range.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      }
      return null;
    };
    return { titles, probes: Object.fromEntries(probes.map((probe) => [probe, find(probe)])) };
  }, probes);
}

async function open(page: Page) {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(STORY);
  const row = (text: string) => page.locator('[data-today-node]', { hasText: text });
  // A cold Storybook compiles the story on first load: that is not a product deadline.
  await expect(row('跟进').locator('[data-today-session]')).toHaveCount(2, { timeout: 120_000 });
  await page.evaluate(() => document.fonts.ready);
  return row;
}

test('a mention takes no room beside a space or punctuation, and keeps a gap against CJK text', async ({
  page,
}) => {
  const row = await open(page);

  // The typed space starts where the title ends: no second gap before `should`.
  const morning = await measure(row('Morning:'), [' should']);
  expect(morning.probes[' should']!.left).toBeCloseTo(morning.titles[0]!.right, 0);

  // Punctuation sits against the title: `flag,` rather than `flag ,`.
  const done = await measure(row('Done:'), [',']);
  expect(done.probes[',']!.left).toBeCloseTo(done.titles[0]!.right, 0);

  // CJK has no spaces: the mention keeps its own gap on both sides, but none before `。`.
  const cjk = await measure(row('跟进'), ['跟进', '的进度', '。']);
  const [first, second] = cjk.titles;
  expect(first!.chipLeft - cjk.probes['跟进']!.right).toBeGreaterThanOrEqual(3);
  expect(cjk.probes['的进度']!.left - first!.right).toBeGreaterThanOrEqual(3);
  expect(cjk.probes['。']!.left).toBeCloseTo(second!.right, 0);
});

test('editing a row keeps every mention and word where the static row drew it', async ({
  page,
}) => {
  const row = await open(page);
  for (const [text, probes] of [
    ['Morning:', [' should', 'Morning:']],
    ['跟进', ['跟进', '的进度', '。']],
  ] as const) {
    const target = row(text);
    const still = await measure(target, [...probes]);
    const box = (await target.boundingBox())!;
    await target.click({ position: { x: box.width - 8, y: box.height / 2 } });
    await expect(target.getByRole('textbox')).toBeVisible();
    await expect(target.locator('[role="textbox"] [data-today-session]')).toHaveCount(
      still.titles.length
    );
    const editing = await measure(target, [...probes]);
    for (const [index, title] of still.titles.entries()) {
      expect(editing.titles[index]!.left).toBeCloseTo(title.left, 0);
      expect(editing.titles[index]!.right).toBeCloseTo(title.right, 0);
    }
    for (const probe of probes) {
      expect(editing.probes[probe]!.left).toBeCloseTo(still.probes[probe]!.left, 0);
    }
  }
});
