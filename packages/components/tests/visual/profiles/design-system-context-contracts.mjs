async function ready(page) {
  await page.waitForFunction(
    () => window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished'
  );
  await page.locator('[data-ds-context] [role="tablist"]').waitFor({ state: 'visible' });
}
const scenarios = [];
for (const theme of ['light', 'dark'])
  for (const width of [390, 1280])
    for (const state of ['rest', 'help', 'connect', 'selected'])
      scenarios.push({
        id: `context-action-${state}-${width}-${theme}`,
        path: `/iframe.html?id=design-system-product-convergence--context-actions&viewMode=story&globals=theme:${theme};locale:en`,
        theme,
        viewport: { width, height: 844 },
        root: 'body',
        ready,
        async act(page) {
          const scope = page.locator('[data-ds-context]');
          if (state === 'help') {
            await scope.getByRole('button', { name: 'Local', exact: true }).hover();
            await page.getByText('Desktop only', { exact: true }).waitFor({ state: 'visible' });
            await page.waitForFunction(() => {
              const tooltip = [...document.querySelectorAll('[data-base-ui-portal] *')].find(
                (node) => node.children.length === 0 && node.textContent === 'Desktop only'
              );
              return (
                tooltip &&
                getComputedStyle(tooltip).opacity === '1' &&
                document
                  .getAnimations()
                  .every(
                    (animation) =>
                      animation.effect?.getTiming().iterations === Infinity ||
                      (!animation.pending && animation.playState !== 'running')
                  )
              );
            });
          }
          if (state === 'connect' || state === 'selected') {
            await scope.locator('[data-context-disabled-action]').click();
            await scope
              .getByRole('tab', { name: 'GitHub', exact: true })
              .waitFor({ state: 'visible' });
            if (state === 'selected')
              await scope.getByRole('tab', { name: 'GitHub', exact: true }).click();
          }
          const result = await scope.evaluate((root, current) => {
            const errors = [];
            const expect = (actual, expected, label) => {
              if (actual !== expected) errors.push(`${label}: ${actual} != ${expected}`);
            };
            expect(
              root.querySelector('[aria-label="Context choice"]').textContent,
              current === 'selected' ? 'github' : 'chat',
              'selection'
            );
            expect(
              root.querySelector('[aria-label="GitHub connection"]').textContent,
              ['connect', 'selected'].includes(current) ? 'Connected' : 'Not connected',
              'connection'
            );
            expect(
              getComputedStyle(root.querySelector('[role="tablist"]')).borderTopWidth,
              '0px',
              'no perimeter border'
            );
            for (const button of root.querySelectorAll('button')) {
              const style = getComputedStyle(button);
              expect(style.opacity, '1', 'enabled action opacity');
              expect(style.fontSize, '13px', 'control type');
            }
            return errors;
          }, state);
          if (result.length) throw Error(result.join('\n'));
        },
      });
export default { name: 'design-system-context-after-behavior-and-material-contracts', scenarios };
