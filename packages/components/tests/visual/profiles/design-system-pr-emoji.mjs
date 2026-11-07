const desktop = { width: 960, height: 720 };
const phone = { width: 390, height: 844 };

async function storyReady(page, theme) {
  await page.waitForFunction((mode) => {
    if (document.body.classList.contains('sb-show-errordisplay')) {
      throw Error(
        document.getElementById('error-message')?.textContent || 'Storybook render failed'
      );
    }
    return (
      window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished' &&
      document.documentElement.classList.contains('dark') === (mode === 'dark')
    );
  }, theme);
}

function scene(id, story, theme, viewport, signal, options = {}) {
  const { ready, ...rest } = options;
  return {
    id,
    path: `/iframe.html?id=${story}&viewMode=story&globals=theme:${theme};locale:en`,
    viewport,
    theme,
    root: 'body',
    async ready(page) {
      await storyReady(page, theme);
      await page.locator(signal).first().waitFor({ state: 'visible' });
      await ready?.(page);
    },
    ...rest,
  };
}

const merge = (id, variant, theme, options) =>
  scene(
    id,
    `migration-ownedmergecontrol--${variant}`,
    theme,
    desktop,
    '[data-owned-merge-fixture]',
    options
  );
async function emojiLoaded(page) {
  await page.locator('[data-slot="emoji-picker-search"]').waitFor({ state: 'visible' });
  await page.locator('[data-slot="emoji-picker-loading"]').waitFor({ state: 'hidden' });
  await page.waitForFunction(() =>
    document.querySelector('[data-slot="emoji-picker-list"]')?.hasAttribute('aria-rowcount')
  );
}
const emoji = (id, variant, theme, options = {}) =>
  scene(id, `ui-emojipickermigration--${variant}`, theme, phone, '[data-slot="emoji-picker"]', {
    ...options,
    async ready(page) {
      await emojiLoaded(page);
      await options.ready?.(page);
    },
  });

async function noFiniteAnimations(page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.effect?.getTiming().iterations === Infinity ||
          ['idle', 'finished'].includes(animation.playState)
      )
  );
}

export default {
  name: 'design-system-pr-emoji',
  scenarios: [
    merge('merge-compact-light', 'ready', 'light'),
    merge('merge-compact-hover-dark', 'ready', 'dark', {
      async act(page) {
        await page.getByRole('button', { name: 'Merge pull request', exact: true }).hover();
        await page.waitForFunction(() =>
          [...document.querySelectorAll('[data-pr-merge-control] button')]
            .find((button) => button.textContent === 'Merge pull request')
            ?.matches(':hover')
        );
      },
    }),
    merge('merge-full-light', 'full-ready', 'light'),
    merge('merge-full-focus-dark', 'full-ready', 'dark', {
      async act(page) {
        await page.getByRole('button', { name: 'Merge pull request', exact: true }).focus();
        await page.waitForFunction(
          () => document.activeElement?.textContent === 'Merge pull request'
        );
      },
    }),
    merge('merge-disabled-light', 'full-disabled', 'light', {
      async ready(page) {
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll('[data-pr-merge-control] button')].find(
              (button) => button.textContent === 'Merge pull request'
            )?.disabled
        );
      },
    }),
    merge('merge-loading-dark', 'merging', 'dark', {
      async ready(page) {
        await page.waitForFunction(() => {
          const buttons = [...document.querySelectorAll('[data-pr-merge-control] button')];
          return (
            buttons.length === 2 &&
            buttons.every((button) => button.disabled) &&
            document.querySelector('[data-pr-merge-control] [data-slot="spinner"]')
          );
        });
      },
    }),
    merge('merge-conflict-light', 'full-conflict', 'light'),
    merge('merge-menu-dark', 'ready', 'dark', {
      async act(page) {
        await page.getByRole('button', { name: 'Choose merge method', exact: true }).click();
        await page
          .getByRole('menuitemradio', { name: 'Squash and merge', exact: true })
          .waitFor({ state: 'visible' });
        await page.waitForFunction(() => {
          const menu = document.querySelector('[role="menu"]');
          if (!menu) return false;
          const style = getComputedStyle(menu);
          return style.opacity === '1' && new DOMMatrixReadOnly(style.transform).isIdentity;
        });
        await noFiniteAnimations(page);
      },
    }),
    merge('merge-selected-method-light', 'ready', 'light', {
      async act(page) {
        await page.getByRole('button', { name: 'Choose merge method', exact: true }).click();
        await page.getByRole('menuitemradio', { name: 'Squash and merge', exact: true }).click();
        await page
          .locator('[data-owned-merge-method="squash"][data-owned-merge-selected-count="1"]')
          .waitFor({ state: 'visible' });
        await page.getByRole('button', { name: 'Squash and merge', exact: true }).click();
        await page
          .locator('[data-owned-merge-count="1"][data-owned-merge-last-method="squash"]')
          .waitFor({ state: 'visible' });
        await page.mouse.move(desktop.width - 2, desktop.height - 2);
        await noFiniteAnimations(page);
      },
    }),
    emoji('emoji-inline-light', 'inline', 'light'),
    emoji('emoji-keyboard-dark', 'inline', 'dark', {
      async act(page) {
        const search = page.locator('[data-slot="emoji-picker-search"]');
        await search.fill('heart');
        await page
          .locator('[data-slot="emoji-picker-list"][aria-rowcount="9"]')
          .waitFor({ state: 'visible' });
        await search.press('ArrowDown');
        await page
          .locator('[data-slot="emoji-picker-emoji"][aria-label="Heart with ribbon"][data-active]')
          .waitFor({ state: 'visible' });
        await page.waitForFunction(() => {
          const active = document.querySelector(
            '[data-slot="emoji-picker-emoji"][aria-label="Heart with ribbon"][data-active]'
          );
          return (
            active?.getAttribute('aria-selected') === 'true' &&
            document
              .getAnimations()
              .every(
                (animation) =>
                  animation.effect?.getTiming().iterations === Infinity ||
                  ['idle', 'finished'].includes(animation.playState)
              )
          );
        });
      },
    }),
    emoji('emoji-disabled-light', 'disabled-search', 'light', {
      async ready(page) {
        await page.waitForFunction(
          () => document.querySelector('[data-slot="emoji-picker-search"]')?.disabled
        );
      },
    }),
    emoji('emoji-empty-dark', 'inline', 'dark', {
      async act(page) {
        await page.locator('[data-slot="emoji-picker-search"]').fill('lody-no-emoji-result-12345');
        await page.locator('[data-slot="emoji-picker-empty"]').waitFor({ state: 'visible' });
      },
    }),
    scene(
      'emoji-consumer-popup-light',
      'ui-emojipickermigration--consumer-popover',
      'light',
      phone,
      'button[aria-label="Emoji"]',
      {
        async act(page) {
          await page.getByRole('button', { name: 'Emoji', exact: true }).click();
          await emojiLoaded(page);
          await noFiniteAnimations(page);
        },
      }
    ),
  ],
};
