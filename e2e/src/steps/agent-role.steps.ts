import { Given, Then, When } from '@cucumber/cucumber';
import type { LodyWorld } from '../support/world.js';

Given('已配置确定性 Agent 的隔离桌面用于 Agent Role 旅程', async function (this: LodyWorld) {
  await this.configureAgentRoleJourney();
});

When('用户创建并在 composer 选择一个 Agent Role', async function (this: LodyWorld) {
  await this.agentRolePage!.createRoleAndSelectIt();
});

When('用户用该 Role 启动一个等待中的 Session', async function (this: LodyWorld) {
  this.agentRoleResources = await this.agentRolePage!.startHeldSession();
});

Then('Session 接受时冻结 Role 标识、版本和精确执行目标', async function (this: LodyWorld) {
  await this.agentRolePage!.expectAcceptedRoleContract(this.agentRoleResources!);
});

When('用户在 dispatch 后编辑该 Agent Role', async function (this: LodyWorld) {
  await this.agentRolePage!.editRoleAfterDispatch();
});

Then('等待中的 Session 仍保留接受时冻结的 Role 配置', async function (this: LodyWorld) {
  await this.agentRolePage!.expectHeldSessionStillUsesAcceptedRole(this.agentRoleResources!);
});

When('用户删除该 Agent Role 并让 Session 完成', async function (this: LodyWorld) {
  await this.agentRolePage!.deleteRoleAndCompleteSession(this.agentRoleResources!);
});

Then('Role 目录项和 Session 均可被永久清理', async function (this: LodyWorld) {
  await this.agentRolePage!.deleteSessionAndVerifyCleanup(this.agentRoleResources!);
  await this.harness!.capturePostGcSnapshot();
});
