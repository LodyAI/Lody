import { Given, Then, When } from '@cucumber/cucumber';
import type { LodyWorld } from '../support/world.js';
import { QueueSessionFixture } from '../support/fixtures/session-queue-fixture.js';
import { QueueSessionPage } from '../support/pages/session-queue-page.js';

type QueueJourney = {
  fixture: QueueSessionFixture;
  page: QueueSessionPage;
};

const journeys = new WeakMap<LodyWorld, QueueJourney>();

function journeyFor(world: LodyWorld): QueueJourney {
  const journey = journeys.get(world);
  if (!journey) throw new Error('The message queue journey has not been configured');
  return journey;
}

Given('已配置消息队列用的确定性 Agent 隔离桌面', async function (this: LodyWorld) {
  if (!this.artifacts || !this.onboarding || !this.harness?.page) {
    throw new Error('Scenario is not ready for message queue setup');
  }
  await this.onboarding.waitForLocalBootstrap();
  const fixture = new QueueSessionFixture(
    `${this.artifacts.scenarioDir}/queue-scripted-acp.ndjson`,
    `${this.artifacts.scenarioDir}/release-queue-prompt`
  );
  const page = new QueueSessionPage(this.harness.page, fixture);
  await this.onboarding.skipConfigurationAndEnterProduct();
  await page.configureCustomAgentAndQueueBehavior();
  journeys.set(this, { fixture, page });
});

When('用户启动一个持续运行的 Session', async function (this: LodyWorld) {
  await journeyFor(this).page.startHeldSession();
});

When('用户依次排队两条后续消息', async function (this: LodyWorld) {
  await journeyFor(this).page.queueFollowUpMessages();
});

When('用户从队列移除第一条后续消息', async function (this: LodyWorld) {
  await journeyFor(this).page.removeFirstFollowUpMessage();
});

Then('当前 Turn 完成后只有保留消息按顺序发送', async function (this: LodyWorld) {
  await journeyFor(this).page.completeAndVerifyOnlyRetainedMessageRuns();
});
