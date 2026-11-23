import { Given, Then, When } from '@cucumber/cucumber';
import type { LodyWorld } from '../support/world.js';

Given('用户已进入待验证的本地 workspace', async function (this: LodyWorld) {
  await this.onboarding!.waitForLocalBootstrap();
  await this.onboarding!.skipConfigurationAndEnterProduct();
});

When('用户为同一个 workspace 打开辅助窗口', async function (this: LodyWorld) {
  await this.desktopWindowCachePage!.openAuxiliaryWorkspace();
});

Then('辅助窗口完成连接并使用与其 Repo 一致的同步进度命名空间', async function (this: LodyWorld) {
  await this.desktopWindowCachePage!.expectAuxiliaryRuntimeCacheIsolation();
});
