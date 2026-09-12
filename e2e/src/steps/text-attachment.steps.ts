import { Given, Then, When } from '@cucumber/cucumber';
import { TextAttachmentFixture } from '../support/fixtures/text-attachment-fixture.js';
import { TextAttachmentPage } from '../support/pages/text-attachment-page.js';
import type { LodyWorld } from '../support/world.js';

type TextAttachmentJourney = {
  page: TextAttachmentPage;
};

const journeys = new WeakMap<LodyWorld, TextAttachmentJourney>();

function journeyFor(world: LodyWorld): TextAttachmentJourney {
  const journey = journeys.get(world);
  if (!journey) {
    throw new Error('The text attachment journey has not been configured');
  }
  return journey;
}

Given('用户已在隔离桌面配置文本附件用的确定性 Agent', async function (this: LodyWorld) {
  if (!this.artifacts || !this.onboarding || !this.harness?.page) {
    throw new Error('Scenario is not ready for text attachment setup');
  }
  await this.onboarding.waitForLocalBootstrap();
  const fixture = new TextAttachmentFixture(
    `${this.artifacts.scenarioDir}/text-attachment-scripted-acp.ndjson`
  );
  const page = new TextAttachmentPage(this.harness.page, fixture);
  await this.onboarding.skipConfigurationAndEnterProduct();
  await page.configureAgentFromSettings();
  journeys.set(this, { page });
});

Given('用户从 New chat 创建了附件主 Session 的真实历史', async function (this: LodyWorld) {
  await journeyFor(this).page.createPrimarySession();
});

When('用户通过 composer 文件选择器取消选择本地文本附件', async function (this: LodyWorld) {
  await journeyFor(this).page.cancelAttachmentPicker();
});

Then('composer 不显示附件预览且不能发送空草稿', async function (this: LodyWorld) {
  await journeyFor(this).page.expectCancelledPickerLeavesEmptyComposer();
});

When('用户通过 composer 文件选择器添加本地文本附件并带文本发送', async function (this: LodyWorld) {
  await journeyFor(this).page.addAndSendLocalTextAttachment();
});

Then(
  '已发送的文本附件预览和提示显示在主 Session 历史中且 composer 草稿已清理',
  async function (this: LodyWorld) {
    await journeyFor(this).page.expectSentAttachmentAndClearedComposer();
  }
);

When('用户在同一 Session 发送后续纯文本消息', async function (this: LodyWorld) {
  await journeyFor(this).page.sendPlainTextFollowUp();
});

Then('后续纯文本消息保留在历史中且不携带旧文本附件', async function (this: LodyWorld) {
  await journeyFor(this).page.expectPlainTextFollowUpWithoutAttachment();
});

When('用户重新载入主 Session 界面', async function (this: LodyWorld) {
  await journeyFor(this).page.reloadPrimarySession();
});

Then('重载后的主 Session 保留文本附件和两条用户消息', async function (this: LodyWorld) {
  await journeyFor(this).page.expectPrimarySessionAfterReload();
});

When('用户归档并从 Archive 恢复包含文本附件的主 Session', async function (this: LodyWorld) {
  await journeyFor(this).page.archiveAndRestorePrimarySession();
});

Then('恢复后的主 Session 仍显示文本附件和后续纯文本历史', async function (this: LodyWorld) {
  await journeyFor(this).page.expectRestoredPrimarySession();
});

When('用户创建另一个不带附件的 Session', async function (this: LodyWorld) {
  await journeyFor(this).page.createAttachmentFreeSession();
});

Then('另一个 Session 看不到主 Session 的文本附件', async function (this: LodyWorld) {
  await journeyFor(this).page.expectAttachmentIsolationInSecondarySession();
});

When('用户永久删除主 Session', async function (this: LodyWorld) {
  await journeyFor(this).page.permanentlyDeletePrimarySession();
});

Then('主 Session 的文本附件已清理且另一个 Session 仍可见', async function (this: LodyWorld) {
  await journeyFor(this).page.expectPrimaryDeletionKeepsSecondarySession();
});

When('用户永久删除另一个 Session', async function (this: LodyWorld) {
  await journeyFor(this).page.permanentlyDeleteSecondarySession();
});

Then('两个 Session 都已从活动列表和 Archive 中清理', async function (this: LodyWorld) {
  await journeyFor(this).page.expectAllSessionsDeleted();
  await this.harness!.capturePostGcSnapshot();
});
