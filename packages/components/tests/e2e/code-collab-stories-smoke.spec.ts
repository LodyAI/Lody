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
    const summary = fatal
      .map((event) => `[${event.level}] ${event.text}`)
      .join('\n');
    expect(fatal, `Story ${storyId} produced console error(s):\n${summary}`).toEqual([]);
  });
}

test('keeps the narrow Monaco Find tooltip clear of its action button', async ({ page }) => {
  test.setTimeout(60_000);

  const storyId = 'sessions-codecollabmonacoeditor--realtime-status-bar-narrow';
  const response = await page.goto(`/iframe.html?id=${storyId}&viewMode=story`);
  expect(response?.ok(), `Story iframe did not return 2xx for ${storyId}`).toBeTruthy();

  const editor = page.locator('.monaco-editor').first();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+f');

  const closeButton = page.getByLabel('Close (Escape)');
  await expect(closeButton).toBeVisible();
  await closeButton.hover();

  const tooltip = page.locator('.workbench-hover-container').filter({ hasText: 'Close (Escape)' });
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator('.hover-contents')).toHaveCSS('white-space', 'nowrap');

  const buttonBounds = await closeButton.boundingBox();
  const tooltipBounds = await tooltip.boundingBox();
  expect(buttonBounds).not.toBeNull();
  expect(tooltipBounds).not.toBeNull();
  if (buttonBounds && tooltipBounds) {
    const overlaps =
      tooltipBounds.x < buttonBounds.x + buttonBounds.width &&
      tooltipBounds.x + tooltipBounds.width > buttonBounds.x &&
      tooltipBounds.y < buttonBounds.y + buttonBounds.height &&
      tooltipBounds.y + tooltipBounds.height > buttonBounds.y;
    expect(overlaps, 'Find tooltip must not overlap its originating action').toBe(false);
  }

  await closeButton.click();
  await expect(closeButton).toBeHidden();
});
