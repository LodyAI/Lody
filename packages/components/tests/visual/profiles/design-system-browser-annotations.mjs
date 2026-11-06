const desktop = { width: 960, height: 720 };
const phone = { width: 390, height: 844 };
function scene(id, story, theme, root, options = {}) {
  return {
    id,
    path: `/iframe.html?id=${story}&viewMode=story&args=page:!false&globals=theme:${theme};locale:en`,
    viewport: options.viewport ?? desktop,
    theme,
    root: 'body',
    async ready(page) {
      await page.waitForFunction((mode) => {
        if (document.body.classList.contains('sb-show-errordisplay'))
          throw Error(document.getElementById('error-message')?.textContent || 'Storybook failed');
        return (
          window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished' &&
          document.documentElement.classList.contains('dark') === (mode === 'dark')
        );
      }, theme);
      await page.locator(root).first().waitFor({ state: 'visible' });
    },
    ...options,
  };
}
const browser = 'sessions-browser-preview-states--';
const draft = 'preview-visualannotationdraftcomposer--';
const overlay = 'preview-visualannotationcommentsoverlay--';
export default {
  name: 'design-system-browser-annotations',
  scenarios: [
    scene(
      'browser-address-focus-light',
      `${browser}local-direct`,
      'light',
      'input[aria-label="Address"]',
      {
        async act(page) {
          await page.getByRole('textbox', { name: 'Address', exact: true }).focus();
        },
      }
    ),
    scene(
      'browser-annotation-pressed-dark',
      `${browser}annotation-enabled`,
      'dark',
      'button[aria-pressed="true"]'
    ),
    scene(
      'browser-loading-phone',
      `${browser}page-loading`,
      'light',
      'button[aria-label="Stop loading"]',
      { viewport: phone }
    ),
    scene(
      'annotation-draft-empty-light',
      `${draft}empty`,
      'light',
      '[data-lody-visual-comment-draft]'
    ),
    scene('annotation-draft-focus-dark', `${draft}ready`, 'dark', 'textarea', {
      async act(page) {
        await page.locator('textarea').focus();
      },
    }),
    scene('annotation-draft-submitting-phone', `${draft}submitting`, 'light', 'textarea', {
      viewport: phone,
    }),
    scene(
      'annotation-threads-light',
      `${overlay}native-states`,
      'light',
      '[data-visual-comment-id="migration-0"]'
    ),
    scene(
      'annotation-send-dark',
      `${overlay}native-states`,
      'dark',
      '[data-visual-comment-id="migration-0"]',
      {
        async act(page) {
          const card = page.locator('[data-visual-comment-id="migration-0"]');
          await card.getByRole('button', { name: 'Send', exact: true }).click();
          await card
            .getByRole('button', { name: 'Added', exact: true })
            .waitFor({ state: 'visible' });
          await page.mouse.move(958, 718);
          await page.waitForFunction(() =>
            document
              .getAnimations()
              .every(
                (animation) =>
                  animation.effect?.getTiming().iterations === Infinity ||
                  ['idle', 'finished'].includes(animation.playState)
              )
          );
        },
      }
    ),
    scene(
      'annotation-collapse-light',
      `${overlay}native-states`,
      'light',
      '[data-lody-visual-comment-overlay]',
      {
        async act(page) {
          await page
            .locator('[data-visual-comment-id="migration-0"]')
            .getByRole('button', { name: 'Collapse comment' })
            .click();
          await page
            .getByRole('button', { name: 'Collapsed comment by Ada Lovelace', exact: true })
            .waitFor({ state: 'visible' });
          await page.mouse.move(958, 718);
        },
      }
    ),
    scene(
      'annotation-corner-peek-dark',
      `${overlay}corner-peeks`,
      'dark',
      'button[aria-label="Collapsed comment by Top Right"]',
      {
        async act(page) {
          await page
            .getByRole('button', { name: 'Collapsed comment by Top Right', exact: true })
            .focus();
        },
      }
    ),
  ],
};
