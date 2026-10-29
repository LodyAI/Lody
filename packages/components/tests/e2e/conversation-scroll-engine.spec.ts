import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { measureTextareaScrollHeight } from '../../src/components/chat/textarea-measurement';
import { compensateConversationScroll } from '../../src/components/ai-gui/conversation-list/scroll-compensation';

for (const timing of ['before native input', 'after native input'] as const) {
  test(`native wheel input keeps reading corrections (${timing})`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setContent(`
    <style>
      body { margin: 0; }
      #viewport { height: 712px; overflow: auto; overflow-anchor: none; scrollbar-gutter: stable; }
      #above { height: 10000px; }
      .row { height: 100px; }
    </style>
    <div id="viewport"><div id="above"></div>
      ${Array.from({ length: 400 }, (_, i) => `<div class="row" id="row-${i}">Synthetic paragraph ${i}</div>`).join('')}
    </div>
  `);
    await page.addScriptTag({
      content: `window.compensateScroll = ${compensateConversationScroll.toString()}`,
    });
    await page.evaluate(
      ({ webKit, timing: inputTiming }) => {
        const viewport = document.querySelector<HTMLElement>('#viewport')!;
        const above = document.querySelector<HTMLElement>('#above')!;
        const state = { step: 0, running: true, reversals: [] as number[], corrections: 0 };
        const testWindow = window as unknown as {
          compensationTest: typeof state;
          compensateScroll: typeof compensateConversationScroll;
        };
        testWindow.compensationTest = state;
        viewport.scrollTop = 30_000;
        // Route every wheel through the web process. This exposes the stale native
        // position reproducibly when a layout correction precedes its default action.
        viewport.addEventListener('wheel', () => {}, { passive: false });
        let previous = new Map<Element, number>();
        let correctedStep = -1;
        const correct = () => {
          if (state.step > 0 && state.step % 12 === 0 && correctedStep !== state.step) {
            correctedStep = state.step;
            above.style.height = `${parseFloat(above.style.height || '10000') + 536}px`;
            testWindow.compensateScroll(viewport, 536, webKit);
            state.corrections++;
          }
        };
        if (inputTiming === 'after native input') viewport.addEventListener('scroll', correct);
        const sample = () => {
          if (!state.running) return;
          const next = new Map<Element, number>();
          for (const row of viewport.querySelectorAll('.row')) {
            const y = row.getBoundingClientRect().top;
            if (y < -100 || y > 712) continue;
            next.set(row, y);
            const before = previous.get(row);
            if (before !== undefined && y < before - 1) state.reversals.push(y - before);
          }
          previous = next;
          if (inputTiming === 'before native input') correct();
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      },
      { webKit: browserName === 'webkit', timing }
    );
    await page.mouse.move(190, 350);
    for (let step = 1; step <= 72; step++) {
      await page.evaluate((value) => {
        (window as unknown as { compensationTest: { step: number } }).compensationTest.step = value;
      }, step);
      await page.mouse.wheel(0, -160);
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      );
    }
    await settleFrames(page, 12);
    const result = await page.evaluate(() => {
      const state = (
        window as unknown as {
          compensationTest: { running: boolean; reversals: number[]; corrections: number };
        }
      ).compensationTest;
      state.running = false;
      const viewport = document.querySelector<HTMLElement>('#viewport')!;
      return {
        ...state,
        top: viewport.scrollTop,
        overflow: getComputedStyle(viewport).overflowY,
      };
    });
    expect(result.corrections).toBe(6);
    expect(result.reversals).toEqual([]);
    const uninterruptedTop = 30_000 - 72 * 160 + 6 * 536;
    if (browserName === 'webkit' && timing === 'before native input') {
      // Releasing native ownership may cancel the in-flight input, just as a
      // programmatic correction can end an iOS fling. Never lose the correction,
      // reverse the reader's motion, or discard subsequent native inputs.
      expect(result.top).toBeGreaterThanOrEqual(uninterruptedTop);
      expect(result.top).toBeLessThanOrEqual(uninterruptedTop + result.corrections * 160);
    } else {
      expect(result.top).toBe(uninterruptedTop);
    }
    expect(result.overflow).toBe('auto');
  });
}

test('composer measurement preserves the conversation layout and reading offset', async ({
  page,
}) => {
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; }
      .page { height: 720px; display: flex; flex-direction: column; }
      .view { flex: 1; min-height: 0; overflow: auto; overflow-anchor: none; }
      .content { height: 4000px; }
      textarea { width: 360px; padding: 0; border: 0; font: 16px/24px monospace;
                 height: 240px; resize: none; }
    </style>
    <div class="page"><div class="view"><div class="content"></div></div>
      <textarea rows="1"></textarea></div>
  `);
  // Execute the production DOM helper in the browser, with actual wrapping
  // and flex sizing rather than jsdom's zero-valued layout properties.
  await page.addScriptTag({ content: measureTextareaScrollHeight.toString() });
  const result = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.view')!;
    const textarea = document.querySelector('textarea')!;
    const measure = (
      window as unknown as {
        measureTextareaScrollHeight: typeof measureTextareaScrollHeight;
      }
    ).measureTextareaScrollHeight;
    const values = [
      Array.from({ length: 10 }, (_, i) => `synthetic ${i}`).join('\n'),
      'wrapped words '.repeat(80),
      '中英文 mixed text '.repeat(60) + '\n',
    ];
    const samples = values.map((value) => {
      textarea.style.height = '240px';
      textarea.value = value;
      viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight - 80;
      const before = { top: viewport.scrollTop, height: viewport.clientHeight };
      const measured = measure(textarea, getComputedStyle(textarea));
      const after = { top: viewport.scrollTop, height: viewport.clientHeight };
      // Reference height, sampled only after asserting the mirror's unchanged
      // geometry. This live reset reproduces the old layout/clamp defect.
      textarea.style.height = 'auto';
      const reference = textarea.scrollHeight;
      const clamped = viewport.scrollTop;
      return { before, after, measured, reference, clamped };
    });
    return { samples, textareas: document.querySelectorAll('textarea').length };
  });
  for (const sample of result.samples) {
    expect(sample.after).toEqual(sample.before);
    expect(sample.measured).toBe(sample.reference);
    expect(sample.clamped).toBeLessThan(sample.before.top);
  }
  expect(result.textareas).toBe(1);
});

// Load the real rules without imports that require Storybook's CSS pipeline.
const markdownStyles = readFileSync(
  new URL('../../src/tailwind/index.css', import.meta.url),
  'utf8'
).replace(/^@import .*$/gm, '');

for (const active of [false, true]) {
  for (const tall of [false, true]) {
    const state = `${active ? 'active' : 'inactive'}, ${tall ? 'tall' : 'fitting'}`;
    test(`Mermaid scroll chaining (${state})`, async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 900 });
      // Isolate native scroll chaining: jsdom wheel dispatch cannot exercise it.
      // The SVG dimensions are synthetic; the diagram DOM matches the renderer.
      await page.setContent(`
        <style>
          #conversation { height: 700px; width: 500px; overflow: auto; }
          .spacer { height: 600px; }
        </style>
        <div id="conversation">
          <div class="spacer"></div>
          <div class="markdown-renderer">
            <div data-streamdown="mermaid" ${active ? 'data-lody-canvas="active"' : ''}>
              <div><div data-streamdown="mermaid-svg">
                <svg width="200" height="${tall ? 1200 : 120}"></svg>
              </div></div>
            </div>
          </div>
          <div class="spacer"></div>
        </div>
      `);
      await page.addStyleTag({ content: markdownStyles });
      const conversation = page.locator('#conversation');
      const diagram = page.locator('[data-streamdown="mermaid"] > div');
      const scrollTop = () => conversation.evaluate((element) => element.scrollTop);

      await conversation.evaluate((element) => {
        element.scrollTop = 550;
      });
      await diagram.hover();
      if (tall) {
        await page.mouse.wheel(0, 80);
        await expect
          .poll(() => diagram.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(0);
        expect(await scrollTop()).toBe(550);
      }

      for (const direction of [-1, 1]) {
        await conversation.evaluate((element) => {
          element.scrollTop = 550;
        });
        await diagram.evaluate((element, down) => {
          element.scrollTop = down ? element.scrollHeight : 0;
        }, direction > 0);
        await diagram.hover();
        await page.mouse.wheel(0, direction * 80);
        await expect.poll(async () => ((await scrollTop()) - 550) * direction).toBeGreaterThan(0);
      }
    });
  }
}

/**
 * The conversation scroll engine in a real browser (scroll-engine note,
 * verification step 5). The central assertion is observed every
 * animation frame, not only at the end: every sampled line of the viewport's
 * content area has a row under it — the conversation is never blank.
 */

const OPEN = '/iframe.html?id=sessions-conversationview--open-long-conversation&viewMode=story';
const SWITCH =
  '/iframe.html?id=sessions-conversationview--switch-between-long-conversations&viewMode=story';

/** Start recording, every animation frame, how many sampled lines have no row under them. */
async function startBlankSampler(page: Page) {
  await page.evaluate(() => {
    const frames: number[] = [];
    let running = true;
    const sample = () => {
      if (!running) return;
      const viewport = document.querySelector<HTMLElement>('[data-conversation-scroll-engine]');
      const content = viewport?.firstElementChild as HTMLElement | null | undefined;
      if (viewport && content) {
        const view = viewport.getBoundingClientRect();
        const rows = content.getBoundingClientRect();
        const style = getComputedStyle(viewport);
        const top = Math.max(view.top + (parseFloat(style.paddingTop) || 0), rows.top) + 2;
        const bottom =
          Math.min(view.bottom - (parseFloat(style.paddingBottom) || 0), rows.bottom) - 2;
        const x = view.left + view.width / 2;
        let blank = 0;
        for (let y = top; y < bottom; y += 16) {
          const hit = document.elementFromPoint(x, y);
          if (!hit?.closest('[data-virtual-index]')) blank += 1;
        }
        frames.push(blank);
      } else {
        frames.push(-1);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    Object.assign(window, {
      __stopBlankSampler: () => {
        running = false;
        return frames;
      },
    });
  });
}

async function stopBlankSampler(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    (window as unknown as { __stopBlankSampler: () => number[] }).__stopBlankSampler()
  );
}

async function settleFrames(page: Page, frames = 10) {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    frames
  );
}

/** The row under the viewport's top content line and its screen offset. */
async function topRow(page: Page) {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[data-conversation-scroll-engine]')!;
    const view = viewport.getBoundingClientRect();
    const y = view.top + (parseFloat(getComputedStyle(viewport).paddingTop) || 0) + 4;
    const row = document
      .elementFromPoint(view.left + view.width / 2, y)
      ?.closest<HTMLElement>('[data-virtual-index]');
    return row
      ? {
          key: row.dataset.conversationRowKey ?? '',
          top: Math.round(row.getBoundingClientRect().top),
        }
      : null;
  });
}

test('opens a 3,000-turn conversation at its end with no blank frame', async ({ page }) => {
  await page.goto(OPEN);
  await expect(page.getByTestId('view-ready')).toHaveText('view-ready', { timeout: 30_000 });
  await startBlankSampler(page);
  await page.getByTestId('open-conversation').click();
  await expect(page.locator('[data-conversation-scroll-engine]')).toBeVisible();
  await settleFrames(page, 20);
  const frames = (await stopBlankSampler(page)).filter((blank) => blank >= 0);
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.filter((blank) => blank > 0)).toEqual([]);
  // Following: the viewport sits at the real bottom.
  const distance = await page
    .locator('[data-conversation-scroll-engine]')
    .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  expect(distance).toBeLessThanOrEqual(1);
});

test('scrolls through history with the wheel and every frame stays covered', async ({ page }) => {
  await page.goto(OPEN);
  await expect(page.getByTestId('view-ready')).toHaveText('view-ready', { timeout: 30_000 });
  await page.getByTestId('open-conversation').click();
  const viewport = page.locator('[data-conversation-scroll-engine]');
  await expect(viewport).toBeVisible();
  await settleFrames(page);
  await viewport.hover();
  await startBlankSampler(page);
  for (let step = 0; step < 30; step++) {
    await page.mouse.wheel(0, -600);
    await settleFrames(page, 2);
  }
  await settleFrames(page, 10);
  const frames = (await stopBlankSampler(page)).filter((blank) => blank >= 0);
  expect(frames.filter((blank) => blank > 0)).toEqual([]);

  // Position, not only coverage: after each settled step, the row that was
  // under the top line moved down by exactly the wheel's distance — rows
  // hydrating or measured around it (placeholders included) never pull it.
  for (let step = 0; step < 10; step++) {
    const before = await topRow(page);
    expect(before).not.toBeNull();
    await page.mouse.wheel(0, -300);
    await settleFrames(page, 10);
    const top = await page
      .locator(`[data-conversation-row-key="${before!.key}"]`)
      .evaluate((row) => Math.round(row.getBoundingClientRect().top));
    expect(top - before!.top, `step ${step}, row ${before!.key}`).toBe(300);
  }
});

test('switching away and back restores the reading position with no blank frame', async ({
  page,
}) => {
  await page.goto(SWITCH);
  await expect(page.getByTestId('view-ready')).toHaveText('view-ready', { timeout: 60_000 });
  await page.getByTestId('select-conversation-0').click();
  const viewport = page.locator('[data-conversation-scroll-engine]');
  await expect(viewport).toBeVisible();
  await settleFrames(page);
  await viewport.hover();
  for (let step = 0; step < 12; step++) {
    await page.mouse.wheel(0, -700);
    await settleFrames(page, 2);
  }
  await settleFrames(page, 10);
  const before = await topRow(page);
  expect(before).not.toBeNull();

  await startBlankSampler(page);
  await page.getByTestId('select-conversation-1').click();
  await settleFrames(page, 10);
  await page.getByTestId('select-conversation-0').click();
  await settleFrames(page, 20);
  const frames = (await stopBlankSampler(page)).filter((blank) => blank >= 0);
  expect(frames.filter((blank) => blank > 0)).toEqual([]);

  const after = await topRow(page);
  expect(after?.key).toBe(before!.key);
  expect(Math.abs((after?.top ?? 0) - before!.top)).toBeLessThanOrEqual(2);
});

const WINDOWED =
  '/iframe.html?id=sessions-conversationview--extreme-conversation-windowed&viewMode=story';

test('outline jumps land their round at the top, far and near, while rows hydrate', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(WINDOWED);
  await page.waitForSelector('[data-outline-index]', { timeout: 60_000 });
  await settleFrames(page, 30);
  // Far, then near (the rows around the first target are hydrating), then back.
  for (const round of [400, 410, 1200, 1195, 10, 5]) {
    await page.locator(`[data-outline-index="${round}"]`).evaluate((element) => {
      (element as HTMLElement).click();
    });
    await settleFrames(page, 60);
    const landed = await page.evaluate((index) => {
      const viewport = document.querySelector('[data-message-selection-scroll]')!;
      const row = document.querySelector(`[data-conversation-turn-id="v-user-${index}"]`);
      const active = document.querySelector('[data-outline-index][aria-current]');
      return {
        distance: row
          ? Math.abs(row.getBoundingClientRect().top - viewport.getBoundingClientRect().top)
          : null,
        active: active ? Number(active.getAttribute('data-outline-index')) : null,
      };
    }, round);
    expect(landed, `round ${round}`).toEqual({ distance: expect.any(Number), active: round });
    expect(landed.distance!, `round ${round}`).toBeLessThanOrEqual(1);
  }
});

for (const width of [375, 1280]) {
  test(`created sessions retain their turn range and scroll in both states at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(
      '/iframe.html?id=sessions-sessionrelationcard--many-created-sessions&viewMode=story'
    );
    const panel = page.locator('[data-created-session-list]');
    const region = panel.getByRole('region');
    const toggle = panel.locator('button[aria-expanded]');
    await expect(page.locator('[data-visible-turn-range]')).toHaveAttribute(
      'data-visible-turn-range',
      '0:22'
    );
    await expect(panel.locator('[data-session-relation-card="opened"]')).toHaveCount(22);
    const collapsedHeight = await region.evaluate((element) => element.clientHeight);
    expect(
      await region.evaluate(
        (element) =>
          [...element.children].filter(
            (child) =>
              child.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom + 1
          ).length
      )
    ).toBe(5);
    for (const expanded of [false, true]) {
      if (expanded) await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', String(expanded));
      expect(await region.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
        true
      );
      await region.hover();
      await page.mouse.wheel(0, 400);
      await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await region.evaluate((element) => {
        element.scrollTop = 0;
      });
    }
    expect(await region.evaluate((element) => element.clientHeight)).toBeGreaterThan(
      collapsedHeight
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(await region.evaluate((element) => element.clientHeight)).toBe(collapsedHeight);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false
    );
  });
}
