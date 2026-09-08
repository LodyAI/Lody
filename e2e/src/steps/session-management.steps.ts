import { Given, Then, When } from '@cucumber/cucumber';
import type { LodyWorld } from '../support/world.js';

Given('已进入无需模型运行时的隔离桌面', async function (this: LodyWorld) {
  await this.onboarding!.waitForLocalBootstrap();
  await this.onboarding!.skipConfigurationAndEnterProduct();
  await this.sessionManagementPage!.enterLocalProduct();
});

Given('已存在包含合成历史的本地 Session', async function (this: LodyWorld) {
  await this.sessionManagementPage!.seedSession();
});

When('用户重命名并置顶该 Session', async function (this: LodyWorld) {
  await this.sessionManagementPage!.renameSession();
  await this.sessionManagementPage!.pinSession();
});

Then('重命名和置顶状态在离开 Session 后仍可见', async function (this: LodyWorld) {
  await this.sessionManagementPage!.expectMetadataAfterNavigation();
});

When('用户归档并从 Archive 恢复该 Session', async function (this: LodyWorld) {
  await this.sessionManagementPage!.archiveAndRestore();
});

Then('恢复后的 Session 保留标题、置顶状态和历史', async function (this: LodyWorld) {
  await this.sessionManagementPage!.expectRestoredState();
});

When('用户永久删除恢复后的 Session', async function (this: LodyWorld) {
  await this.sessionManagementPage!.permanentlyDelete();
});

Then('Session 已从列表和路由中清理', async function (this: LodyWorld) {
  await this.sessionManagementPage!.expectDeletedFromListAndRoute();
});
