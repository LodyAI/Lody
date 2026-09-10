import { Given, Then, When } from '@cucumber/cucumber';
import type { LodyWorld } from '../support/world.js';

Given('用户已在隔离桌面配置确定性 Agent', async function (this: LodyWorld) {
  await this.configureSessionManagementJourney();
});

Given('用户从 New chat 创建了包含真实历史的 Session', async function (this: LodyWorld) {
  await this.sessionManagementPage!.createSession();
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

Then('Session 已从活动列表和 Archive 中清理', async function (this: LodyWorld) {
  await this.sessionManagementPage!.expectDeletedFromLists();
});
