async function ready(page) {
  await page.waitForFunction(
    () => window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished'
  );
  await page.locator('[role="tablist"]').waitFor({ state: 'visible' });
}
const scenarios = [];
for (const theme of ['light', 'dark'])
  for (const width of [390, 1280])
    for (const state of ['rest', 'selected'])
      scenarios.push({
        id: `context-${state}-${width}-${theme}`,
        path: `/iframe.html?id=migration-ownedcontexttypography--long-tab-labels&viewMode=story&globals=theme:${theme};locale:en`,
        theme,
        viewport: { width, height: 844 },
        root: 'body',
        ready,
        async act(page) {
          if (state === 'selected') {
            await page.getByRole('tab', { name: 'Independent conversations' }).click();
            await page.waitForFunction(
              () => document.querySelector('output')?.textContent === 'chat'
            );
          }
        },
      });
export default { name: 'design-system-context-intentional-material-change', scenarios };
