import { Given, Then, When } from '@cucumber/cucumber';
import type { LodyWorld } from '../support/world.js';
import { TurnLifecycleFixture } from '../support/fixtures/turn-lifecycle-fixture.js';
import { TurnLifecyclePage } from '../support/pages/turn-lifecycle-page.js';

type TurnJourney = {
  fixture: TurnLifecycleFixture;
  page: TurnLifecyclePage;
  restartedSessionId?: string;
  interruptedSessionId?: string;
};

const journeys = new WeakMap<LodyWorld, TurnJourney>();

function journeyFor(world: LodyWorld): TurnJourney {
  const journey = journeys.get(world);
  if (!journey) throw new Error('The Turn lifecycle journey has not been configured');
  return journey;
}

Given('已配置 Turn 生命周期用的确定性 Agent', async function (this: LodyWorld) {
  if (!this.artifacts || !this.harness?.page) {
    throw new Error('Scenario is not ready for Turn lifecycle setup');
  }
  const fixture = new TurnLifecycleFixture(
    `${this.artifacts.scenarioDir}/turn-lifecycle-scripted-acp.ndjson`
  );
  const page = new TurnLifecyclePage(this.harness.page, fixture);
  await page.configureCustomAgent();
  journeys.set(this, { fixture, page });
});

When('用户启动一个等待权限批准的 Session', async function (this: LodyWorld) {
  await journeyFor(this).page.startSessionAwaitingPermission();
});

When('用户批准该权限请求', async function (this: LodyWorld) {
  await journeyFor(this).page.approvePermission();
});

When('用户发送一条会让 Agent 进程崩溃的消息', async function (this: LodyWorld) {
  await journeyFor(this).page.sendTurnThatCrashesTheAgent();
});

Then('崩溃的 Turn 被释放且后续消息在新的 Agent 进程中按顺序执行', async function (this: LodyWorld) {
  await journeyFor(this).page.expectCrashedTurnReleasedAndFollowUpRecovers();
});

When('用户完成一个 Turn 后冷重启桌面', async function (this: LodyWorld) {
  const journey = journeyFor(this);
  journey.restartedSessionId = await journey.page.completeTurnBeforeRestart();
  const root = this.harness!.getIsolatedRoot();
  await this.harness!.close({ preserveRoot: true });
  await this.launch({ reuseRoot: root, forceOnboarding: false });
  journey.page = new TurnLifecyclePage(this.harness!.page!, journey.fixture);
});

Then(
  '重新打开该 Session 后发送的后续消息只执行一次且回复排在消息之后',
  async function (this: LodyWorld) {
    const journey = journeyFor(this);
    if (!journey.restartedSessionId) throw new Error('No Session was completed before restart');
    await journey.page.reopenSessionAndSendFollowUp(journey.restartedSessionId);
  }
);

When('用户启动一个持续工作的 Turn', async function (this: LodyWorld) {
  const journey = journeyFor(this);
  journey.interruptedSessionId = await journey.page.startLongRunningTurn();
});

When('桌面在 Turn 运行中正常退出后重新启动', async function (this: LodyWorld) {
  const journey = journeyFor(this);
  const root = this.harness!.getIsolatedRoot();
  await this.harness!.close({ preserveRoot: true });
  await this.launch({ reuseRoot: root, forceOnboarding: false });
  journey.page = new TurnLifecyclePage(this.harness!.page!, journey.fixture);
});

When('桌面和它启动的全部进程在 Turn 运行中被强制杀死后重新启动', async function (this: LodyWorld) {
  const journey = journeyFor(this);
  const root = this.harness!.getIsolatedRoot();
  await this.harness!.killProcessTree();
  await this.launch({ reuseRoot: root, forceOnboarding: false });
  journey.page = new TurnLifecyclePage(this.harness!.page!, journey.fixture);
});

Then('被打断的 Turn 无需用户操作就在新的 Agent 进程中继续一次', async function (this: LodyWorld) {
  const journey = journeyFor(this);
  if (!journey.interruptedSessionId) throw new Error('No Turn was interrupted');
  await journey.page.expectInterruptedTurnContinuesWithoutUserAction(journey.interruptedSessionId);
});

Then('被打断的 Session 仍然列出并能打开之前的对话', async function (this: LodyWorld) {
  const journey = journeyFor(this);
  if (!journey.interruptedSessionId) throw new Error('No Turn was interrupted');
  await journey.page.expectSessionListedWithHistory(journey.interruptedSessionId);
});
