import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * Story render smoke for the Code Collab Storybook surfaces.
 *
 * Plan acceptance: Phase 5 calls for "Playwright story render smoke tests for the
 * critical stories if story URLs are stable." The IDs below come from the
 * canonical Storybook index (`packages/components/storybook-static/index.json`)
 * and stay stable as long as the title + story export names do.
 *
 * The intent is correctness-only: each story must render without crashing and
 * without emitting console errors. This is not a visual-regression suite.
 */
const CODE_COLLAB_STORY_IDS: readonly string[] = [
  // File state matrices.
  'sessions-codecollabfilestates--file-tree-state-matrix',
  'sessions-codecollabfilestates--text-buffer-too-large',
  'sessions-codecollabfilestates--blob-upload-too-large',
  'sessions-codecollabfilestates--line-too-long',
  'sessions-codecollabfilestates--unsupported-encoding',
  // Monaco editor status bar stories.
  'sessions-codecollabmonacoeditor--realtime-status-bar-online',
  'sessions-codecollabmonacoeditor--realtime-status-bar-offline',
  'sessions-codecollabmonacoeditor--realtime-status-bar-narrow',
  'sessions-codecollabmonacoeditor--realtime-status-bar-conflict',
  'sessions-codecollabmonacoeditor--deleted-open-file',
  'sessions-codecollabmonacoeditor--recreated-same-path',
  'sessions-codecollabmonacoeditor--renamed-open-file',
];

// Storybook itself surfaces noisy but non-fatal warnings (deprecations,
// HMR-related logs, dev-only React warnings on storybook internals). Only
// failures that would surface to a user count.
const IGNORED_CONSOLE_PATTERNS: readonly RegExp[] = [
  /\[DEPRECATED\] atomFamily/,
  /Failed to load resource: the server responded with a status of 404 \(Not Found\)/,
  /Encountered two children with the same key/i,
  // Storybook's docs runtime probes optional features.
  /docs\/(addon|api)/i,
];

type ConsoleEvent = {
  readonly level: ConsoleMessage['type'] | 'pageerror';
  readonly text: string;
};

function attachConsoleCollector(page: Page): { readonly events: readonly ConsoleEvent[] } {
  const events: ConsoleEvent[] = [];
  page.on('console', (message) => {
    const level = message.type();
    if (level !== 'error' && level !== 'warning') return;
    events.push({ level, text: message.text() });
  });
  page.on('pageerror', (error) => {
    events.push({ level: 'pageerror', text: error.message });
  });
  return { events };
}

function notIgnored(event: ConsoleEvent): boolean {
  return !IGNORED_CONSOLE_PATTERNS.some((pattern) => pattern.test(event.text));
}

for (const storyId of CODE_COLLAB_STORY_IDS) {
  test(`renders ${storyId} without console errors`, async ({ page }) => {
    test.setTimeout(60_000);

    const collector = attachConsoleCollector(page);

    const response = await page.goto(`/iframe.html?id=${storyId}&viewMode=story`);
    expect(response?.ok(), `Story iframe did not return 2xx for ${storyId}`).toBeTruthy();

    const storybookRoot = page.locator('#storybook-root');
    await expect(storybookRoot).toBeAttached({ timeout: 30_000 });
    // Some stories render their visible UI through a Portal (Quick Open
    // dialog, command palette, etc.) so `#storybook-root` itself may stay
    // empty. Require *something* rendered into either the root or the body
    // before we sample console errors.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const rootEl = document.querySelector('#storybook-root');
            const rootChildren = rootEl?.childElementCount ?? 0;
            const portalChildren = document.body.childElementCount;
            return rootChildren + portalChildren;
          }),
        { timeout: 20_000 }
      )
      .toBeGreaterThan(0);

    // Allow lazy chunks (Monaco workers, code-collab provider chunk) to
    // settle before we sample console errors.
    await page.waitForLoadState('networkidle', { timeout: 20_000 });

    const fatal = collector.events.filter((event) => event.level !== 'warning').filter(notIgnored);
    const summary = fatal.map((event) => `[${event.level}] ${event.text}`).join('\n');
    expect(fatal, `Story ${storyId} produced console error(s):\n${summary}`).toEqual([]);
  });
}

test('file line links reveal and highlight their range on first open and later navigation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/iframe.html?id=sessions-codecollabmonacoeditor--line-anchors&viewMode=story');
  const editor = page.locator('.monaco-editor');
  await expect(editor).toHaveCount(0);

  const expectHighlightedLine = async (line: number) => {
    const row = editor.locator('.view-line').filter({ hasText: `// synthetic line ${line}:` });
    await expect(row).toBeInViewport();
    await expect
      .poll(() =>
        row.evaluate((element) => {
          const target = element.getBoundingClientRect();
          return Array.from(
            element.closest('.monaco-editor')!.querySelectorAll('.rangeHighlight')
          ).some((highlight) => {
            const rect = highlight.getBoundingClientRect();
            const color = getComputedStyle(highlight).backgroundColor;
            return (
              rect.top <= target.top + 1 &&
              rect.bottom >= target.bottom - 1 &&
              rect.width > 0 &&
              color !== 'transparent' &&
              color !== 'rgba(0, 0, 0, 0)'
            );
          });
        })
      )
      .toBe(true);
  };

  const farLink = page.getByRole('link', { name: 'source.ts:6303-6305', exact: true });
  await farLink.click();
  await expect(page.getByLabel('Caret line', { exact: true })).toHaveText('6303');
  await expectHighlightedLine(6303);
  await expectHighlightedLine(6305);

  await page.setViewportSize({ width: 920, height: 700 });
  await expect
    .poll(
      async () => (await editor.locator('.monaco-scrollable-element').boundingBox())?.width ?? 0
    )
    .toBeGreaterThan(800);
  await expectHighlightedLine(6303);

  await page.getByRole('link', { name: 'source.ts:47-47', exact: true }).click();
  await expectHighlightedLine(47);
  await farLink.click();
  await expectHighlightedLine(6303);

  const isMac = await page.evaluate(() => /Mac/.test(navigator.platform));
  await editor
    .getByRole('textbox', { name: 'Code file preview', exact: true })
    .press(isMac ? 'Meta+ArrowUp' : 'Control+Home');
  await expect(
    editor.locator('.view-line').filter({ hasText: '// synthetic line 1:' })
  ).toBeInViewport();
  await expect(
    editor.locator('.view-line').filter({ hasText: '// synthetic line 6303:' })
  ).toHaveCount(0);
  await farLink.click();
  await expectHighlightedLine(6303);
  await expectHighlightedLine(6305);
});
