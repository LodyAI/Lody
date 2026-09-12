import { Given, Then, When } from '@cucumber/cucumber';
import { ContextCopyFixture } from '../support/fixtures/context-copy-fixture.js';
import { ContextCopyPage } from '../support/pages/context-copy-page.js';
import type { LodyWorld } from '../support/world.js';

type ContextCopyJourney = {
  fixture: ContextCopyFixture;
  page: ContextCopyPage;
};

const journeys = new WeakMap<LodyWorld, ContextCopyJourney>();

function journeyFor(world: LodyWorld): ContextCopyJourney {
  const journey = journeys.get(world);
  if (!journey) throw new Error('The conversation context copy journey has not been configured');
  return journey;
}

Given('用户已在隔离桌面配置上下文复制用的确定性 Agent', async function (this: LodyWorld) {
  if (!this.artifacts || !this.onboarding || !this.harness?.page) {
    throw new Error('Scenario is not ready for conversation context copy setup');
  }
  await this.onboarding.waitForLocalBootstrap();
  const fixture = new ContextCopyFixture(
    `${this.artifacts.scenarioDir}/context-copy-scripted-acp.ndjson`,
    `${this.artifacts.scenarioDir}/context-copy-release-main-stream.signal`
  );
  const page = new ContextCopyPage(this.harness.page, fixture);
  await this.onboarding.skipConfigurationAndEnterProduct();
  await page.configureAgentFromSettings();
  journeys.set(this, { fixture, page });
});

Given('用户创建了含富 Markdown 的两轮可区分主 Session 历史', async function (this: LodyWorld) {
  await journeyFor(this).page.createRichPrimarySession();
});

When('用户从首条用户消息的分叉菜单复制 Markdown 上下文', async function (this: LodyWorld) {
  await journeyFor(this).page.copyContextThroughFirstUserMessage();
});

Then('剪贴板只包含该用户消息，不包含之后的 Agent 或用户历史', async function (this: LodyWorld) {
  await journeyFor(this).page.expectClipboardThroughFirstUserMessage();
});

When('用户从首条 Agent 回复的分叉菜单复制 Markdown 上下文', async function (this: LodyWorld) {
  await journeyFor(this).page.copyContextThroughFirstAssistantResponse();
});

Then(
  '剪贴板包含该回复及此前富 Markdown，排除之后历史且没有原生分叉目标',
  async function (this: LodyWorld) {
    await journeyFor(this).page.expectClipboardThroughFirstAssistantResponse();
  }
);

When('用户重新载入上下文复制主 Session 界面', async function (this: LodyWorld) {
  await journeyFor(this).page.reloadPrimarySession();
});

Then('主 Session 历史和按 Agent 回复的上下文复制仍然成立', async function (this: LodyWorld) {
  await journeyFor(this).page.expectPrimaryHistoryAndCopyPersistAfterReload();
});

When(
  '主 Session 的 Agent 通过显式 ACP 信号开始未完成的流式回复并导出完整 Markdown',
  async function (this: LodyWorld) {
    await journeyFor(this).page.startPrimaryStreamingAndCopyCompleteSession();
  }
);

Then('剪贴板包含流式前缀和未完成响应标记', async function (this: LodyWorld) {
  await journeyFor(this).page.expectIncompletePrimarySessionClipboard();
});

When('确定性 ACP 收到继续主 Session 流式回复的外部信号', async function (this: LodyWorld) {
  await journeyFor(this).page.releasePrimaryStreamingResponse();
});

Then(
  '完成后的完整 Session 导出包含流式结尾且不再带未完成响应标记',
  async function (this: LodyWorld) {
    await journeyFor(this).page.expectCompletedPrimarySessionClipboard();
  }
);

When('用户创建第二个 Session，开始流式回复后从界面取消', async function (this: LodyWorld) {
  await journeyFor(this).page.createAndCancelIsolatedStreamingSession();
});

Then(
  '第二个 Session 的完整导出只含自身的已取消边界，并有 ACP 取消证据',
  async function (this: LodyWorld) {
    await journeyFor(this).page.expectIsolatedCancelledSessionClipboard();
  }
);

When('用户从界面永久删除两个上下文复制 Session', async function (this: LodyWorld) {
  await journeyFor(this).page.permanentlyDeleteSessions();
});

Then('上下文复制 Session 已从活动列表和 Archive 中清理', async function (this: LodyWorld) {
  await journeyFor(this).page.expectSessionsDeleted();
  await this.harness!.capturePostGcSnapshot();
});
