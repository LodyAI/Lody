import { Given, Then, When } from '@cucumber/cucumber';
import type { LodyWorld } from '../support/world.js';

Given('用户已进入无需模型运行时的隔离桌面并打开 Appearance 设置', async function (this: LodyWorld) {
  await this.configureAppearanceJourney();
});

When('用户提交浅色主题', async function (this: LodyWorld) {
  await this.appearancePage!.commitLightTheme();
});

Then('已提交的浅色主题在重开 Settings 后保持可见', async function (this: LodyWorld) {
  await this.appearancePage!.expectCommittedLightThemeAfterSettingsReopen();
});

When('用户预览深色主题后取消', async function (this: LodyWorld) {
  await this.appearancePage!.previewDarkThemeAndCancel();
});

Then('取消预览不会覆盖已提交的浅色主题', async function (this: LodyWorld) {
  await this.appearancePage!.expectCancelledPreviewKeepsCommittedLightTheme();
});
