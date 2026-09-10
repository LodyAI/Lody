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

Given('已建立含 child Tab 和两个独立 worktree 的 Session 关系', async function (this: LodyWorld) {
  await this.sessionForkPage!.addProjectAndSelectAgent();
  const firstFork = await this.sessionForkPage!.createCompletedSourceAndForkToWorktree();
  const secondFork = await this.sessionForkPage!.createAdditionalWorktreeFork(firstFork);
  this.sessionRelationLifecycleResources = await this.sessionManagementPage!.seedRelationLifecycle(
    firstFork,
    secondFork
  );
});

When('用户归档并永久删除 opener Session', async function (this: LodyWorld) {
  await this.sessionManagementPage!.archiveRelationRoot(this.sessionRelationLifecycleResources!);
  await this.sessionManagementPage!.permanentlyDeleteRelationRoot(
    this.sessionRelationLifecycleResources!
  );
});

Then('child Tab 被删除而 opened Sessions 和 worktree 保留', async function (this: LodyWorld) {
  await this.sessionManagementPage!.expectDanglingProvenanceAndCleanup(
    this.sessionRelationLifecycleResources!
  );
});

Then(
  'metadata 未完成 hydration 时精确删除 empty child Tab 仍成功',
  async function (this: LodyWorld) {
    await this.sessionManagementPage!.expectColdHydrationExactDelete();
    await this.harness!.capturePostGcSnapshot();
  }
);
