import { expect, test } from '@playwright/test';

const cases = [
  {
    locale: 'en',
    names: [
      'Show code-only line changes',
      'Enable push notifications',
      'When the PR is merged',
      'When the PR is closed',
    ],
    codeHelper: 'Sidebar line counts skip docs, tests, and dev config.',
  },
  {
    locale: 'zh_CN',
    names: ['仅展示代码行变更', '启用推送通知', 'PR 被合并时', 'PR 被关闭时'],
    codeHelper: '侧边栏的行数统计不计文档、测试和开发配置。',
  },
];

const notificationService = `
let optedIn = false;
const client = {
  login: async () => {},
  User: {
    setLanguage: () => {},
    PushSubscription: {
      optIn: async () => { optedIn = true; },
      optOut: async () => { optedIn = false; },
    },
  },
  Notifications: {
    requestPermission: () => new Promise(resolve => {
      window.finishNotificationPermission = () => resolve(true);
    }),
  },
};
export const initOneSignal = async () => client;
export const loadOneSignalSdk = initOneSignal;
export const isOneSignalSupported = () => true;
export const getOneSignalPermissionState = async () => 'granted';
export const getOneSignalPushSubscriptionOptedIn = async () => optedIn;
export const withOneSignal = async callback => callback(client);
export const scheduleOneSignalTask = callback => { void withOneSignal(callback); };
`;

for (const { locale, names, codeHelper } of cases) {
  test(`Preferences exposes switch names, descriptions and keyboard state in ${locale}`, async ({
    page,
  }) => {
    // This browser context has synthetic preferences and no notification SDK or account access.
    await page.route('https://**/*', (route) => route.abort());
    await page.goto(
      `/iframe.html?id=settings-generalsettings--preferences-accessibility&viewMode=story&globals=locale:${locale}`
    );

    for (const name of names) {
      const control = page.getByRole('switch', { name, exact: true });
      await expect(control).toHaveCount(1);
      await expect(control).toHaveAccessibleName(name);
      await expect(control).toHaveAttribute('aria-checked', /^(true|false)$/);
    }

    const code = page.getByRole('switch', { name: names[0], exact: true });
    await expect(code).toHaveAccessibleDescription(codeHelper);
    const notification = page.getByRole('switch', { name: names[1], exact: true });
    await expect(notification).toBeDisabled();
    const description = await notification.getAttribute('aria-describedby');
    expect(description).toBeTruthy();
    await expect(page.locator(`[id="${description}"]`)).not.toBeEmpty();

    for (const index of [0, 2, 3]) {
      const control = page.getByRole('switch', { name: names[index], exact: true });
      await expect(control).toHaveAttribute('aria-checked', 'false');
      await control.focus();
      await expect(control).toBeFocused();
      await page.keyboard.press('Space');
      await expect(control).toHaveAttribute('aria-checked', 'true');
      await expect(control).toHaveAccessibleName(names[index]);
      await page.keyboard.press('Enter');
      await expect(control).toHaveAttribute('aria-checked', 'false');
    }

    await code.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('switch', { name: names[2], exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('switch', { name: names[3], exact: true })).toBeFocused();
  });

  test(`Preferences keeps notification name and state through keyboard activation in ${locale}`, async ({
    page,
  }) => {
    await page.route('https://**/*', (route) => route.abort());
    await page.route('**/src/lib/onesignal.ts*', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: notificationService })
    );
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    });
    await page.goto(
      `/iframe.html?id=settings-generalsettings--preferences-accessibility&viewMode=story&globals=locale:${locale}`
    );

    const notification = page.getByRole('switch', { name: names[1], exact: true });
    await expect(notification).toBeEnabled();
    await expect(notification).toHaveAttribute('aria-checked', 'false');
    await expect(notification).not.toHaveAttribute('aria-describedby');
    await page.getByRole('switch', { name: names[0], exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(notification).toBeFocused();
    await page.keyboard.press('Space');
    await expect(notification).toHaveCount(0);
    await expect(page.getByRole('status')).toBeVisible();
    await page.evaluate(() => {
      (
        window as unknown as { finishNotificationPermission: () => void }
      ).finishNotificationPermission();
    });
    await expect(notification).toHaveAttribute('aria-checked', 'true');
    await expect(notification).toHaveAccessibleName(names[1]);
    await notification.focus();
    await page.keyboard.press('Enter');
    await expect(notification).toHaveAttribute('aria-checked', 'false');
    await expect(notification).toHaveAccessibleName(names[1]);
  });
}
