const desktop = { width: 1280, height: 1000 };
const phone = { width: 390, height: 844 };
async function ready(page) {
  await page.waitForFunction(() => {
    if (document.body.classList.contains('sb-show-errordisplay'))
      throw Error(document.getElementById('error-message')?.textContent || 'Story render failed');
    return (
      window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished' &&
      document.querySelector('#storybook-root textarea')
    );
  });
  await page.locator('#storybook-root textarea').first().waitFor({ state: 'visible' });
}
function scenario(id, story, theme, viewport, act) {
  return {
    id,
    path: `/iframe.html?id=${story}&viewMode=story&globals=theme:${theme};locale:en`,
    theme,
    viewport,
    root: 'body',
    ready,
    act,
  };
}
const scenarios = [];
for (const theme of ['light', 'dark']) {
  for (const [name, story, viewport] of [
    ['landing', 'migration-ownedcomposerinput--landing', desktop],
    ['session-mobile', 'migration-ownedcomposerinput--session', phone],
    ['dialog', 'migration-ownedcomposerinput--dialog', desktop],
    ['disabled', 'migration-ownedcomposerinput--disabled-secondary', desktop],
    ['fallback', 'migration-ownedcomposerinput--plain-fallback', desktop],
    ['secondary', 'migration-ownedcomposerinput--landing-secondary', desktop],
    ['scoped', 'migration-ownedcomposersurface--scoped-session', desktop],
    ['attachments', 'chat-chatcomposer--attachment-upload-states', desktop],
    ['attachments-mobile', 'chat-chatcomposer--attachment-upload-states', phone],
  ])
    scenarios.push(scenario(`${name}-${theme}`, story, theme, viewport));
  scenarios.push(
    scenario(
      `focus-${theme}`,
      'migration-ownedcomposerinput--landing',
      theme,
      desktop,
      async (page) => {
        await page.locator('#migration-composer-input').focus();
        await page.waitForFunction(() => document.activeElement?.id === 'migration-composer-input');
      }
    )
  );
  scenarios.push(
    scenario(
      `typing-${theme}`,
      'migration-ownedcomposerinput--session',
      theme,
      phone,
      async (page) => {
        await page.locator('#migration-composer-input').fill('Review the synthetic change.');
        await page.waitForFunction(
          () =>
            document.querySelector('[data-input-value]')?.textContent ===
            'Review the synthetic change.'
        );
      }
    )
  );
}
export default { name: 'design-system-core-intentional-changes', scenarios };
