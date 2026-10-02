import { defineConfig } from '@playwright/test';

const storybookUrl = process.env.LODY_STORYBOOK_URL ?? 'http://127.0.0.1:6006';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: storybookUrl,
    trace: 'on-first-retry',
  },
  webServer: {
    command: `pnpm storybook --ci --host 127.0.0.1 --port ${new URL(storybookUrl).port || '6006'}`,
    url: storybookUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
