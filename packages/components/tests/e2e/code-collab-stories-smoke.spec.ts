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

// Storage is synthetic; the editor, undo stack, save hook and toolbar are real.
test('undo to saved text clears dirty state, redo restores it, and Save advances the baseline', async ({
  page,
}) => {
  await page.goto(
    '/iframe.html?id=sessions-codecollabmonacoeditor--undo-to-saved-text&viewMode=story'
  );
  const original = 'QA_STARTED_20261004';
  const draft = `${original}_UNSAVED_QA`;
  const editorText = page.locator('.view-lines');
  const editor = page.getByRole('textbox', { name: 'Code file editor' });
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  const modifier = await page.evaluate(() =>
    navigator.platform.includes('Mac') ? 'Meta' : 'Control'
  );
  const protectedFromUnload = () =>
    page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
  await expect(editorText).toHaveText(original);
  await expect(save).toBeDisabled();
  await expect(refresh).toBeEnabled();
  // Monaco uses EditContext on current Chromium; click its visible line rather
  // than its hidden IME textarea before sending real keyboard events.
  await page.locator('.view-line').click();
  await editor.press(modifier === 'Meta' ? 'Meta+ArrowRight' : 'End');
  await page.keyboard.insertText('_UNSAVED_QA');
  await expect(editorText).toHaveText(draft);
  await expect(save).toBeEnabled();
  expect(await protectedFromUnload()).toBe(true);
  const closeCanceled = new Promise<void>((resolve, reject) => {
    page.once('dialog', async (dialog) => {
      try {
        expect(dialog.type()).toBe('beforeunload');
        await dialog.dismiss();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  await page.close({ runBeforeUnload: true });
  await closeCanceled;
  await expect(editorText).toHaveText(draft);
  await editor.press(`${modifier}+z`);
  await expect(editorText).toHaveText(original);
  await expect(page.getByText('Unsaved', { exact: true })).toHaveCount(0);
  await expect(save).toBeDisabled();
  await expect(refresh).toBeEnabled();
  expect(await protectedFromUnload()).toBe(false);
  await editor.press(modifier === 'Meta' ? 'Meta+Shift+z' : 'Control+y');
  await expect(editorText).toHaveText(draft);
  await expect(save).toBeEnabled();
  await expect(refresh).toBeDisabled();
  expect(await protectedFromUnload()).toBe(true);
  await save.click();
  await expect(save).toBeDisabled();
  await expect(refresh).toBeEnabled();
  expect(await protectedFromUnload()).toBe(false);
  await editor.press(`${modifier}+z`);
  await expect(editorText).toHaveText(original);
  await expect(save).toBeEnabled();
  await editor.press(modifier === 'Meta' ? 'Meta+Shift+z' : 'Control+y');
  await expect(editorText).toHaveText(draft);
  await expect(save).toBeDisabled();
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(editorText).toHaveText(draft);
});
