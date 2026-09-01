import { defineConfig } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 6006);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL,
    trace: 'on-first-retry',
    ...(process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === '1' ? { channel: 'chrome' as const } : {}),
  },
  webServer: {
    command: `pnpm exec storybook dev -p ${port} --ci`,
    env: {
      VITE_PREVIEW_PUBLIC_BASE_DOMAIN:
        process.env.VITE_PREVIEW_PUBLIC_BASE_DOMAIN ?? 'local.invalid',
    },
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
