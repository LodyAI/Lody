import { Given, Then, When } from '@cucumber/cucumber';
import type { LodyWorld } from '../support/world.js';

Given('已配置支持分叉的确定性 Agent 桌面', async function (this: LodyWorld) {
  await this.configureSessionForkAgent();
});

Given('已添加用于 Session 分叉的干净合成 Git 项目', async function (this: LodyWorld) {
  await this.sessionForkPage!.addProjectAndSelectAgent();
});

When('用户把已完成的源 Session 分叉到新 worktree', async function (this: LodyWorld) {
  this.sessionForkResources = await this.sessionForkPage!.createCompletedSourceAndForkToWorktree();
});

Then('分叉保留来源和对话且删除后不改变源 Session', async function (this: LodyWorld) {
  await this.sessionForkPage!.verifyOriginAndCleanup(this.sessionForkResources!);
  await this.harness!.capturePostGcSnapshot();
});
