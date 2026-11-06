const desktop = { width: 960, height: 720 };
const phone = { width: 390, height: 844 };

async function rendered(page, theme) {
  await page.waitForFunction((mode) => {
    if (document.body.classList.contains('sb-show-errordisplay'))
      throw Error(
        document.getElementById('error-message')?.textContent || 'Storybook render failed'
      );
    return (
      window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished' &&
      document.documentElement.classList.contains('dark') === (mode === 'dark')
    );
  }, theme);
}
function scene(id, story, theme, viewport, signal, options = {}) {
  return {
    id,
    path: `/iframe.html?id=ui-commandmigration--${story}&viewMode=story&globals=theme:${theme};locale:en`,
    viewport,
    theme,
    root: 'body',
    async ready(page) {
      await rendered(page, theme);
      await page.locator(signal).first().waitFor({ state: 'visible' });
    },
    ...options,
  };
}
async function modalReady(page) {
  await page.getByRole('dialog').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const modal = document.querySelector('[role="dialog"]');
    return (
      modal &&
      getComputedStyle(modal).opacity === '1' &&
      document
        .getAnimations()
        .every(
          (animation) =>
            animation.effect?.getTiming().iterations === Infinity ||
            ['idle', 'finished'].includes(animation.playState)
        )
    );
  });
}
export default {
  name: 'design-system-command',
  scenarios: [
    scene('command-input-focus-light', 'inline', 'light', desktop, '[cmdk-input]', {
      async act(page) {
        await page.getByRole('combobox', { name: 'Search commands' }).focus();
        await page.waitForFunction(() => document.activeElement?.hasAttribute('cmdk-input'));
      },
    }),
    scene('command-keyboard-selection-dark', 'inline', 'dark', desktop, '[cmdk-input]', {
      async act(page) {
        const input = page.getByRole('combobox', { name: 'Search commands' });
        await input.fill('workspace');
        await page
          .locator('[cmdk-item][data-value="open-workspace"][data-selected="true"]')
          .waitFor({ state: 'visible' });
        await input.press('Enter');
        await page.waitForFunction(
          () =>
            document.querySelector('output[aria-label="Selected command"]')?.textContent ===
            'open-workspace'
        );
      },
    }),
    scene('command-disabled-dark', 'input-disabled', 'dark', phone, '[cmdk-input]', {
      async act(page) {
        await page.waitForFunction(() => document.querySelector('[cmdk-input]')?.disabled);
      },
    }),
    scene('command-empty-light', 'inline', 'light', phone, '[cmdk-input]', {
      async act(page) {
        await page
          .getByRole('combobox', { name: 'Search commands' })
          .fill('lody-no-command-result-12345');
        await page
          .getByText('No matching commands.', { exact: true })
          .waitFor({ state: 'visible' });
      },
    }),
    scene('command-dialog-light', 'in-dialog', 'light', desktop, '#storybook-root button', {
      async act(page) {
        await page.getByRole('button', { name: 'Open command dialog', exact: true }).click();
        await modalReady(page);
        await page.getByRole('combobox', { name: 'Search commands' }).focus();
      },
    }),
    scene('command-dialog-dismiss-dark', 'in-dialog', 'dark', phone, '#storybook-root button', {
      async act(page) {
        await page.getByRole('button', { name: 'Open command dialog', exact: true }).click();
        await modalReady(page);
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await page.mouse.move(phone.width - 2, phone.height - 2);
      },
    }),
    scene('command-scroll-dark', 'overflow', 'dark', desktop, '[cmdk-input]', {
      async act(page) {
        await page.locator('[cmdk-item]').first().waitFor({ state: 'visible' });
        const viewport = page.locator('[data-scroll-area-viewport]');
        await viewport.hover();
        const ended = viewport.evaluate(
          (node) =>
            new Promise((resolve) =>
              node.addEventListener('scrollend', () => resolve(node.scrollTop), { once: true })
            )
        );
        await page.mouse.wheel(0, 480);
        if ((await ended) <= 0) throw Error('Command list did not scroll');
        await page.mouse.move(desktop.width - 2, desktop.height - 2);
      },
    }),
    scene('command-caller-parts-light', 'caller-overrides', 'light', desktop, '[cmdk-input]'),
  ],
};
