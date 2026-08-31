import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://127.0.0.1:6006',
    trace: 'on-first-retry',
    ...(process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === '1' ? { channel: 'chrome' as const } : {}),
  },
  webServer: {
    command: 'pnpm storybook --ci',
    env: {
      VITE_PREVIEW_PUBLIC_BASE_DOMAIN:
        process.env.VITE_PREVIEW_PUBLIC_BASE_DOMAIN ?? 'local.invalid',
    },
    url: 'http://127.0.0.1:6006',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
