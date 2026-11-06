const desktop = { width: 1280, height: 900 };
const phone = { width: 390, height: 844 };

async function finishedStory(page, theme) {
  await page.waitForFunction((expectedTheme) => {
    if (document.body.classList.contains('sb-show-errordisplay')) {
      throw new Error(
        document.getElementById('error-message')?.textContent || 'Storybook render failed'
      );
    }
    return (
      window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished' &&
      document.documentElement.classList.contains('dark') === (expectedTheme === 'dark')
    );
  }, theme);
}

function scenario(id, story, theme, viewport, signal, extra = {}) {
  const { ready: check, ...rest } = extra;
  return {
    id,
    path: `/iframe.html?id=${story}&viewMode=story&globals=theme:${theme};locale:en`,
    viewport,
    theme,
    root: 'body',
    async ready(page) {
      await finishedStory(page, theme);
      await page.locator(signal).first().waitFor({ state: 'visible' });
      if (check) await check(page);
    },
    ...rest,
  };
}

async function composerDisabled(page) {
  await page.waitForFunction(() =>
    document.getElementById('migration-composer-input')?.matches(':disabled')
  );
}

async function openedDrawer(page) {
  await page.getByRole('dialog').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const panel = document.querySelector('[role="dialog"] aside');
    if (!panel) return false;
    const transform = getComputedStyle(panel).transform;
    return transform === 'none' || new DOMMatrixReadOnly(transform).m41 === 0;
  });
}

export default {
  name: 'components',
  scenarios: [
    scenario(
      'composer-landing-light',
      'migration-ownedcomposerinput--landing',
      'light',
      desktop,
      '[data-composer-input-fixture] textarea'
    ),
    scenario(
      'composer-session-focus-dark',
      'migration-ownedcomposerinput--session',
      'dark',
      desktop,
      '[data-composer-input-fixture] textarea',
      {
        async act(page) {
          const input = page.locator('#migration-composer-input');
          await input.fill('Compare the migrated UI.');
          await input.focus();
          await page.waitForFunction(
            () =>
              document.activeElement?.id === 'migration-composer-input' &&
              document.querySelector('[data-input-value]')?.textContent ===
                'Compare the migrated UI.'
          );
        },
      }
    ),
    scenario(
      'composer-disabled-light',
      'migration-ownedcomposerinput--disabled',
      'light',
      desktop,
      '[data-composer-input-fixture] textarea',
      { ready: composerDisabled }
    ),
    scenario(
      'composer-hover-dark',
      'migration-ownedcomposerinput--landing-secondary',
      'dark',
      desktop,
      '[data-composer-input-fixture] textarea',
      {
        async act(page) {
          await page.locator('[data-clear-input]').hover();
          await page.waitForFunction(() =>
            document.querySelector('[data-clear-input]')?.matches(':hover')
          );
        },
      }
    ),
    scenario(
      'sidebar-desktop-dark',
      'migration-ownedlegacysidebarparts--default',
      'dark',
      desktop,
      '[data-sidebar-parts-fixture] [data-sidebar="sidebar"]'
    ),
    scenario(
      'sidebar-action-hover-light',
      'migration-ownedlegacysidebarparts--default',
      'light',
      desktop,
      '[data-sidebar-parts-fixture] [data-sidebar="sidebar"]',
      {
        async act(page) {
          await page.getByRole('button', { name: 'default synthetic item', exact: true }).hover();
          await page.waitForFunction(() => {
            const action = document.querySelector('[aria-label="Actions default"]');
            return action && getComputedStyle(action).opacity === '1';
          });
        },
      }
    ),
    scenario(
      'sidebar-collapse-dark',
      'migration-ownedlegacysidebarparts--default',
      'dark',
      desktop,
      '[data-sidebar-parts-fixture] [data-sidebar="sidebar"]',
      {
        async act(page) {
          await page
            .getByRole('button', { name: 'Toggle parts from content', exact: true })
            .click();
          await page
            .locator('[data-sidebar-parts-state="collapsed"]')
            .waitFor({ state: 'visible' });
          await page.mouse.move(desktop.width - 2, desktop.height - 2);
          await page.waitForFunction(
            () =>
              !document.querySelector('[aria-label="Toggle parts from content"]')?.matches(':hover')
          );
        },
      }
    ),
    scenario(
      'drawer-open-dark',
      'components-mobilesidebardrawer--closed',
      'dark',
      phone,
      '#storybook-root button',
      {
        async act(page) {
          await page.getByRole('button', { name: 'Open drawer', exact: true }).click();
          await openedDrawer(page);
          await page.mouse.move(phone.width - 2, phone.height - 2);
          await page.waitForFunction(
            () =>
              ![...document.querySelectorAll('button')]
                .find((button) => button.textContent === 'Open drawer')
                ?.matches(':hover')
          );
        },
      }
    ),
    scenario(
      'drawer-close-light',
      'components-mobilesidebardrawer--closed',
      'light',
      phone,
      '#storybook-root button',
      {
        async act(page) {
          await page.getByRole('button', { name: 'Open drawer', exact: true }).click();
          await openedDrawer(page);
          const scrim = page.getByRole('button', { name: /close navigation menu/i });
          const box = await scrim.boundingBox();
          if (!box) throw new Error('Open drawer has no close scrim geometry');
          await scrim.click({ position: { x: box.width - 8, y: box.height / 2 } });
          await page.waitForFunction(() => {
            const close = document.querySelector('button[aria-label="Close navigation menu"]');
            return close && getComputedStyle(close).visibility === 'hidden';
          });
        },
      }
    ),
    scenario(
      'markdown-emphasis-dark',
      'ai-gui-markdown-emphasis--completed',
      'dark',
      desktop,
      '.markdown-renderer strong',
      {
        async ready(page) {
          await page.getByText('English bold.', { exact: true }).waitFor({ state: 'visible' });
        },
      }
    ),
    scenario(
      'markdown-table-phone-light',
      'conversation-markdown-tables--phone',
      'light',
      phone,
      '.markdown-renderer table',
      {
        async ready(page) {
          await page
            .locator('.markdown-renderer table tbody tr')
            .first()
            .waitFor({ state: 'visible' });
        },
      }
    ),
    scenario(
      'settings-launch-focus-light',
      'settings-generalsettings--auto-launch-off',
      'light',
      desktop,
      '[data-settings-surface] #auto-launch-toggle',
      {
        async act(page) {
          await page.locator('#auto-launch-toggle').focus();
          await page.waitForFunction(() => document.activeElement?.id === 'auto-launch-toggle');
        },
      }
    ),
    scenario(
      'settings-unsupported-dark',
      'settings-generalsettings--auto-launch-unsupported',
      'dark',
      desktop,
      '[data-settings-surface] #auto-launch-toggle',
      {
        async ready(page) {
          await page.waitForFunction(() => {
            const control = document.getElementById('auto-launch-toggle');
            return (
              control &&
              (control.matches(':disabled') || control.getAttribute('aria-disabled') === 'true')
            );
          });
        },
      }
    ),
    scenario(
      'skills-loading-light',
      'mobile-mobileprojectskills--owned-loading',
      'light',
      phone,
      '[data-owned-skills-fixture] [data-slot="icon-spinner"][data-spinning="true"]',
      {
        async ready(page) {
          await page.getByText('Loading skills', { exact: true }).waitFor({ state: 'visible' });
        },
      }
    ),
    scenario(
      'skills-long-description-dark',
      'mobile-mobileprojectskills--long-description',
      'dark',
      phone,
      '[data-owned-skills-fixture]',
      {
        async ready(page) {
          await page
            .getByRole('button', { name: 'Refresh', exact: true })
            .waitFor({ state: 'visible' });
          await page
            .getByText(/Review a synthetic change while preserving layout/)
            .waitFor({ state: 'visible' });
        },
      }
    ),
    scenario(
      'session-menu-pending-dark',
      'mobile-mobilesessionmenusheet--pending-spinners-dark',
      'dark',
      phone,
      '[data-session-spinner-projection="menu"]',
      {
        async act(page) {
          await page
            .getByRole('button', { name: 'Open pending session menu', exact: true })
            .click();
          await page.getByRole('dialog').waitFor({ state: 'visible' });
          await page.getByRole('button', { name: /Fork session$/ }).waitFor({ state: 'visible' });
          await page.waitForFunction(() => {
            const dialog = document.querySelector('[role="dialog"]');
            const fork = [...(dialog?.querySelectorAll('button') || [])].find(
              (button) => button.textContent === 'Fork session'
            );
            return (
              fork &&
              (fork.disabled || fork.getAttribute('aria-disabled') === 'true') &&
              dialog.querySelectorAll('[data-slot="spinner"]').length === 3
            );
          });
          await page.waitForFunction(() => {
            const dialog = document.querySelector('[role="dialog"]');
            if (!dialog) return false;
            const style = getComputedStyle(dialog);
            const transform = new DOMMatrixReadOnly(style.transform);
            const pending = document
              .getAnimations()
              .some(
                (animation) =>
                  animation.effect?.getTiming().iterations !== Infinity &&
                  !['finished', 'idle'].includes(animation.playState)
              );
            return !pending && style.opacity === '1' && transform.isIdentity;
          });
        },
      }
    ),
  ],
};
