import { join } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import { McpAppFixture } from '../support/fixtures/mcp-app-fixture.js';
import { McpAppPage } from '../support/pages/mcp-app-page.js';
import type { LodyWorld } from '../support/world.js';

const pages = new WeakMap<LodyWorld, McpAppPage>();

function pageFor(world: LodyWorld): McpAppPage {
  const page = pages.get(world);
  if (!page) throw new Error('The MCP App journey has not been configured');
  return page;
}

Given('已配置提供 MCP App 的确定性 Agent 隔离桌面', async function (this: LodyWorld) {
  if (!this.artifacts || !this.onboarding || !this.harness?.page || !this.harness.app) {
    throw new Error('Scenario is not ready for MCP App setup');
  }
  await this.onboarding.waitForLocalBootstrap();
  const fixture = new McpAppFixture(
    join(this.artifacts.scenarioDir, 'mcp-app-scripted-acp.ndjson')
  );
  const page = new McpAppPage(this.harness.page, this.harness.app, fixture);
  await this.onboarding.skipConfigurationAndEnterProduct();
  await page.configureAgentFromSettings();
  pages.set(this, page);
});

When('用户发送会调用带界面工具的消息', async function (this: LodyWorld) {
  await pageFor(this).sendMcpAppPrompt();
});

Then(
  '对话中显示 "Opened Synthetic Board" 卡片且内嵌应用展示工具结果',
  async function (this: LodyWorld) {
    await pageFor(this).expectCardShowsToolResult();
  }
);

Then(
  '内嵌应用运行在 opaque origin 中并能使用内存 storage 与 cookie',
  async function (this: LodyWorld) {
    await pageFor(this).expectAppStorageInOpaqueOrigin();
  }
);

When('用户在内嵌应用中触发一次应用可见工具调用', async function (this: LodyWorld) {
  await pageFor(this).addCardFromApp();
});

Then('工具调用经 ACP 扩展方法往返并更新内嵌应用', async function (this: LodyWorld) {
  await pageFor(this).expectRoundTripUpdatedApp(
    join(this.artifacts!.scenarioDir, 'mcp-app-card.png')
  );
});

When('用户重新加载桌面主窗口', async function (this: LodyWorld) {
  await pageFor(this).reloadMainWindow();
});

Then('内嵌应用重新运行且之前写入的 storage 既未保留也未写入磁盘', async function (this: LodyWorld) {
  await pageFor(this).expectAppStorageWasEphemeral(
    join(this.artifacts!.scenarioDir, 'mcp-app-storage-probe.json'),
    join(this.artifacts!.scenarioDir, 'mcp-app-card-reloaded.png')
  );
});
