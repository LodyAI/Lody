import { defineConfig } from '@playwright/test';

const storybookPort = Number(process.env.STORYBOOK_PORT ?? 6006);
const storybookUrl = `http://127.0.0.1:${storybookPort}`;

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
    command: `pnpm storybook --ci -p ${storybookPort}`,
    url: storybookUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
