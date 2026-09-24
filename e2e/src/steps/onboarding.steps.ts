import { Given, Then, When } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import type { LodyWorld } from '../support/world.js';

Given('一个全新隔离的 Lody Desktop 已启动', async function (this: LodyWorld) {
  expect(await this.harness?.page?.evaluate(() => window.__LODY_ELECTRON__)).toBe(true);
});

Then('bundled CLI 拥有本地 runtime 并完成 workspace 初始化', async function (this: LodyWorld) {
  const state = await this.onboarding!.waitForLocalBootstrap();
  expect(state.cli?.runtime?.pid).toEqual(expect.any(Number));
});

When('用户跳过 Agent 配置并进入本地 workspace', async function (this: LodyWorld) {
  await this.onboarding!.skipConfigurationAndEnterProduct();
});

Then('真实产品会话输入界面可用', async function (this: LodyWorld) {
  await expect(this.harness!.page!.locator('#chat-prompt')).toBeEditable();
  await this.harness!.captureSnapshot();
});
