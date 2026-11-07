const widths = [
  { width: 390, height: 844 },
  { width: 1440, height: 1000 },
];
const themes = ['light', 'dark'];
const pages = [
  { id: 'introduction', path: '/docs/' },
  { id: 'quickstart', path: '/docs/quickstart/' },
  { id: 'sessions', path: '/docs/session/' },
];

async function finiteAnimationsFinished(page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => {
      if (animation.effect?.getComputedTiming().iterations === Infinity) return true;
      return !animation.pending && animation.playState !== 'running';
    })
  );
}

async function docsReady(page) {
  await page.locator('#nd-page h1').first().waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => {
    const layout = document.querySelector('#nd-docs-layout');
    const article = document.querySelector('#nd-page');
    // An active scrollspy item is an observable client effect, unlike static HTML.
    const activeHeading = document.querySelector('#nd-toc a[data-active="true"]');
    if (!layout || !article || !activeHeading) return false;
    if (
      getComputedStyle(layout).display !== 'grid' ||
      getComputedStyle(article).display !== 'flex'
    ) {
      return false;
    }
    const toc = document.querySelector('#nd-toc');
    if (toc && getComputedStyle(toc).display !== 'none') {
      const track = toc.querySelector('[style*="--track-top"]');
      const list = track?.nextElementSibling;
      const active = list?.querySelectorAll('a[data-active="true"]');
      if (!track || !active?.length) return false;
      const first = active[0];
      const last = active[active.length - 1];
      const top = first.offsetTop + parseFloat(getComputedStyle(first).paddingTop);
      const bottom =
        last.offsetTop + last.clientHeight - parseFloat(getComputedStyle(last).paddingBottom);
      if (
        parseFloat(track.style.getPropertyValue('--track-top')) !== top ||
        parseFloat(track.style.getPropertyValue('--track-bottom')) !== bottom
      )
        return false;
      const points = getComputedStyle(track)
        .clipPath.match(/^polygon\((.*)\)$/)?.[1]
        .split(',');
      const vertical = points?.map((point) => parseFloat(point.trim().split(/\s+/)[1]));
      if (!vertical || vertical.some((value, index) => value !== (index < 2 ? top : bottom)))
        return false;
    }
    return [...document.images].every((image) => {
      const box = image.getBoundingClientRect();
      const visible = box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight;
      return !visible || (image.complete && image.naturalWidth > 0);
    });
  });
  await finiteAnimationsFinished(page);
}

async function openMobileToc(page) {
  const trigger = page.locator('[data-toc-popover-trigger]');
  await trigger.click();
  await page.waitForFunction(() => {
    const triggerNode = document.querySelector('[data-toc-popover-trigger]');
    const panel = document.querySelector('[data-toc-popover-content]');
    return (
      triggerNode?.getAttribute('aria-expanded') === 'true' &&
      panel?.getBoundingClientRect().height > 0
    );
  });
  await finiteAnimationsFinished(page);
}

async function searchByKeyboard(page) {
  await page.keyboard.press('Control+k');
  const dialog = page.locator('#fd-search-dialog-content');
  await dialog.waitFor({ state: 'visible' });
  const input = dialog.locator('input');
  await input.fill('session');
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('#fd-search-dialog-content button[aria-selected]');
    return rows.length >= 2 && rows[0].getAttribute('aria-selected') === 'true';
  });
  await input.press('ArrowDown');
  await page.waitForFunction(() => {
    const dialogNode = document.querySelector('#fd-search-dialog-content');
    const rows = dialogNode?.querySelectorAll('button[aria-selected]');
    return (
      rows?.length >= 2 &&
      rows[1].getAttribute('aria-selected') === 'true' &&
      rows[0].getAttribute('aria-selected') === 'false' &&
      dialogNode.querySelector('input') === document.activeElement
    );
  });
  await finiteAnimationsFinished(page);
}

async function languageOpen(page, mobile) {
  if (mobile) await openMobileToc(page);
  const container = mobile ? '[data-toc-popover-content]' : '#nd-toc';
  const trigger = page
    .locator(container)
    .getByRole('button', { name: 'Choose a language', exact: true });
  await trigger.click();
  await page.getByRole('button', { name: '简体中文', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute('aria-expanded') === 'true',
    `${container} button[aria-label="Choose a language"]`
  );
  await finiteAnimationsFinished(page);
}

const scenarios = [];
for (const viewport of widths) {
  for (const theme of themes) {
    for (const item of pages) {
      scenarios.push({
        id: `${item.id}-${viewport.width}-${theme}`,
        path: item.path,
        viewport,
        theme,
        root: '#nd-docs-layout',
        ready: docsReady,
      });
    }
    scenarios.push({
      id: `search-keyboard-second-result-${viewport.width}-${theme}`,
      path: '/docs/session/',
      viewport,
      theme,
      root: 'body',
      ready: docsReady,
      act: searchByKeyboard,
    });
    scenarios.push({
      id: `toc-${viewport.width === 390 ? 'expanded' : 'keyboard-focus'}-${viewport.width}-${theme}`,
      path: '/docs/session/',
      viewport,
      theme,
      root: '#nd-docs-layout',
      ready: docsReady,
      act: async (page) => {
        if (viewport.width === 390) {
          await openMobileToc(page);
        } else {
          const first = page.locator('#nd-toc a[href^="#"]').first();
          await first.focus();
          await page.waitForFunction(
            () => document.querySelector('#nd-toc a[href^="#"]') === document.activeElement
          );
          await finiteAnimationsFinished(page);
        }
      },
    });
    scenarios.push({
      id: `language-open-${viewport.width}-${theme}`,
      path: '/docs/session/',
      viewport,
      theme,
      root: 'body',
      ready: docsReady,
      act: (page) => languageOpen(page, viewport.width === 390),
    });
  }
}

export default {
  name: 'docs',
  // Optional analytics are deliberately aborted and recorded. Every other
  // off-origin request is a capture failure under the shared runner policy.
  blockedRequests: ['https://www.clarity.ms/tag/', 'https://www.googletagmanager.com/gtag/js?'],
  scenarios,
};
