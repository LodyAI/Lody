import { Given, Then, When } from '@cucumber/cucumber';
import { AgentProviderLifecycleFixture } from '../support/fixtures/agent-provider-lifecycle-fixture.js';
import { AgentProviderLifecyclePage } from '../support/pages/agent-provider-lifecycle-page.js';
import type { LodyWorld } from '../support/world.js';

type AgentProviderJourney = {
  fixture: AgentProviderLifecycleFixture;
  page: AgentProviderLifecyclePage;
};

const journeys = new WeakMap<LodyWorld, AgentProviderJourney>();

function journeyFor(world: LodyWorld): AgentProviderJourney {
  const journey = journeys.get(world);
  if (!journey) throw new Error('Agent Provider lifecycle journey has not been prepared');
  return journey;
}

Given('用户已进入隔离桌面并准备管理 Agent Provider', async function (this: LodyWorld) {
  if (!this.artifacts || !this.onboarding || !this.harness?.page) {
    throw new Error('Scenario is not ready for Agent Provider lifecycle setup');
  }
  await this.onboarding.waitForLocalBootstrap();
  const fixture = new AgentProviderLifecycleFixture(
    `${this.artifacts.scenarioDir}/agent-provider-lifecycle-acp.ndjson`
  );
  const page = new AgentProviderLifecyclePage(this.harness.page, fixture);
  await this.onboarding.skipConfigurationAndEnterProduct();
  journeys.set(this, { fixture, page });
});

When('用户测试无效 custom command 后取消配置', async function (this: LodyWorld) {
  await journeyFor(this).page.rejectInvalidProviderAndCancel();
});

Then('失败的 Provider 不会进入目录', async function (this: LodyWorld) {
  await journeyFor(this).page.expectRejectedProviderAbsent();
});

When('用户创建并测试一个 custom command Agent Provider', async function (this: LodyWorld) {
  await journeyFor(this).page.createProvider();
});

Then('新 Provider 在重开 Settings 后保留名称、命令和自定义提示', async function (this: LodyWorld) {
  await journeyFor(this).page.expectInitialProviderPersisted();
});

When('用户编辑草稿后取消', async function (this: LodyWorld) {
  await journeyFor(this).page.cancelDraftEdits();
});

Then('已保存 Provider 不受取消的编辑污染', async function (this: LodyWorld) {
  await journeyFor(this).page.expectCancelledEditsDidNotPersist();
});

When('用户保存重命名后的命令和自定义提示并创建第二个 Provider', async function (this: LodyWorld) {
  await journeyFor(this).page.saveEditedProviderAndCreateAlternate();
});

When('用户重载桌面', async function (this: LodyWorld) {
  await journeyFor(this).page.reloadDesktop();
});

Then(
  '编辑后的 Provider 和第二个 Provider 均保持可用，旧名称不会出现在目录或 composer',
  async function (this: LodyWorld) {
    await journeyFor(this).page.expectReloadedProviderMatrix();
  }
);

When(
  '用户明确选择编辑后的 Provider 创建第一个 Session，再选择第二个 Provider 创建第二个 Session',
  async function (this: LodyWorld) {
    await journeyFor(this).page.createIsolatedSessions();
  }
);

Then(
  '两个 Session 的选择和历史彼此隔离，并由各自的 ACP command 与提示完成',
  async function (this: LodyWorld) {
    const { page, fixture } = journeyFor(this);
    await page.expectIsolatedSessionMatrix();
    await fixture.expectIsolatedSessionPrompts();
  }
);

When('用户删除编辑后的 Provider', async function (this: LodyWorld) {
  await journeyFor(this).page.deleteEditedProvider();
});

Then(
  'catalog 不再提供该 Provider，而既有 Session 保留其完成历史',
  async function (this: LodyWorld) {
    await journeyFor(this).page.expectDeletedProviderSessionBehavior();
  }
);

When('用户永久删除两个 Session 并移除第二个 Provider', async function (this: LodyWorld) {
  await journeyFor(this).page.deleteSessionsAndAlternateProvider();
});

Then('Session 和 Agent Provider 目录项均被清理', async function (this: LodyWorld) {
  await journeyFor(this).page.expectCatalogAndSessionCleanup();
  await this.harness!.capturePostGcSnapshot();
});
