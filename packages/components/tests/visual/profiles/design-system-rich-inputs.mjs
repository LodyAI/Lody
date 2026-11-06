async function ready(page) {
  await page.waitForFunction(
    () => window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished'
  );
  await page.locator('textarea').first().waitFor({ state: 'visible' });
}
const scenarios = [];
for (const theme of ['light', 'dark'])
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 1000 },
  ]) {
    for (const story of [
      'ai-gui-usermessageeditor--with-mentions',
      'ai-gui-usermessageeditor--saving',
      'settings-promptshortcutform--default',
    ]) {
      scenarios.push({
        id: `${story.replaceAll('--', '-')}-${viewport.width}-${theme}`,
        path: `/iframe.html?id=${story}&viewMode=story&globals=theme:${theme};locale:en`,
        viewport,
        theme,
        root: 'body',
        ready,
      });
    }
  }
export default { name: 'design-system-rich-input-material-changes', scenarios };
