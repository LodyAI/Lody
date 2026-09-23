import { Given, Then, When } from '@cucumber/cucumber';
import type { LodyWorld } from '../support/world.js';

Given('已配置确定性 Agent 的隔离桌面用于 MCP 旅程', async function (this: LodyWorld) {
  await this.configureMcpCatalogJourney();
});

When('用户创建一个合成 stdio MCP 服务器', async function (this: LodyWorld) {
  await this.mcpPage!.createSyntheticStdioServer();
});

When('用户在 composer 中显式选择该 MCP 服务器', async function (this: LodyWorld) {
  await this.mcpPage!.selectServerForNextTurn();
});

When('用户发送一个完成的 Turn', async function (this: LodyWorld) {
  this.mcpSessionEvent = await this.mcpPage!.createCompletedSession();
});

Then('bundled CLI 将该 Turn 的 MCP 选择传入 ACP 启动', async function (this: LodyWorld) {
  await this.mcpPage!.expectSelectedServerAtAcpStartup(this.mcpSessionEvent!);
});

When('用户删除该 workspace MCP 服务器', async function (this: LodyWorld) {
  await this.mcpPage!.deleteSyntheticServer();
});

Then('目录项已删除且已完成 Turn 的 MCP 启动选择保持不变', async function (this: LodyWorld) {
  await this.mcpPage!.expectServerDeletedAndPriorTurnPreserved(this.mcpSessionEvent!);
  await this.mcpPage!.deleteSessionAndReleaseAgent(this.mcpSessionEvent!);
  await this.harness!.capturePostGcSnapshot();
});
