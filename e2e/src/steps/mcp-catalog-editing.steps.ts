import { Given, Then, When } from '@cucumber/cucumber';
import type { LodyWorld } from '../support/world.js';

Given('已准备隔离桌面用于 MCP 目录编辑', async function (this: LodyWorld) {
  await this.configureMcpCatalogEditingJourney();
});

When('用户创建一个默认启用的合成 MCP 服务器', async function (this: LodyWorld) {
  await this.mcpCatalogEditingPage!.createDefaultEnabledServer();
});

Then('该 MCP 服务器的初始目录项在重开设置后保持可见且默认启用', async function (this: LodyWorld) {
  await this.mcpCatalogEditingPage!.expectInitialEntryPersisted();
});

When('用户编辑该 MCP 服务器的名称和描述', async function (this: LodyWorld) {
  await this.mcpCatalogEditingPage!.editServer();
});

Then('编辑后的目录项在重开设置后保持可见', async function (this: LodyWorld) {
  await this.mcpCatalogEditingPage!.expectEditedEntryPersisted();
});

When('用户禁用再重新启用该 MCP 服务器', async function (this: LodyWorld) {
  await this.mcpCatalogEditingPage!.disableAndReEnableServer();
});

Then('重新启用状态在重开设置后保持可见', async function (this: LodyWorld) {
  await this.mcpCatalogEditingPage!.expectReEnabledEntryPersisted();
});

When('用户删除该 MCP 服务器', async function (this: LodyWorld) {
  await this.mcpCatalogEditingPage!.deleteServer();
});

Then('删除后的空目录在重开设置后保持可见', async function (this: LodyWorld) {
  await this.mcpCatalogEditingPage!.expectDeletedEntryPersisted();
});
