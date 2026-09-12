import { Given, Then, When } from '@cucumber/cucumber';
import { GoalSessionFixture } from '../support/fixtures/session-goal-fixture.js';
import { GoalSessionPage } from '../support/pages/session-goal-page.js';
import type { LodyWorld } from '../support/world.js';

type GoalJourney = {
  fixture: GoalSessionFixture;
  page: GoalSessionPage;
};

const journeys = new WeakMap<LodyWorld, GoalJourney>();

function journeyFor(world: LodyWorld): GoalJourney {
  const journey = journeys.get(world);
  if (!journey) throw new Error('The Session goal journey has not been configured');
  return journey;
}

Given('已配置目标控制用的确定性 Agent 隔离桌面', async function (this: LodyWorld) {
  if (!this.artifacts || !this.onboarding || !this.harness?.page) {
    throw new Error('Scenario is not ready for Session goal setup');
  }
  await this.onboarding.waitForLocalBootstrap();
  const fixture = new GoalSessionFixture(
    `${this.artifacts.scenarioDir}/session-goal-scripted-acp.ndjson`
  );
  const page = new GoalSessionPage(this.harness.page, fixture);
  await this.onboarding.skipConfigurationAndEnterProduct();
  await page.configureAgentFromSettings();
  journeys.set(this, { fixture, page });
});

When('用户启动一个持续运行的目标 Session', async function (this: LodyWorld) {
  await journeyFor(this).page.startRunningGoal();
});

Then('用户能看到运行中的目标及其可用控制', async function (this: LodyWorld) {
  await journeyFor(this).page.expectRunningGoalControls();
});

When('用户在第二个 Session 中完成独立工作后返回目标 Session', async function (this: LodyWorld) {
  await journeyFor(this).page.completeIndependentSessionAndReturnToGoal();
});

Then('两个 Session 的目标状态和 ACP 事件彼此隔离', async function (this: LodyWorld) {
  await journeyFor(this).page.expectSessionIsolation();
});

When('用户暂停运行中的目标', async function (this: LodyWorld) {
  await journeyFor(this).page.pauseRunningGoal();
});

Then('Pause 通过 ACP 控制请求到达且目标显示为已暂停', async function (this: LodyWorld) {
  await journeyFor(this).page.expectPausedGoalAndControlEvidence();
});

Then('重复或当前状态不允许的目标操作不会产生错误状态', async function (this: LodyWorld) {
  await journeyFor(this).page.expectPausedGoalRejectsDuplicateActions();
});

When('用户更新已暂停目标的目标和用量元数据', async function (this: LodyWorld) {
  await journeyFor(this).page.updatePausedGoal();
});

Then('ACP 更新快照和 UI 显示更新后的目标元数据', async function (this: LodyWorld) {
  await journeyFor(this).page.expectUpdatedGoalMetadataAndWireEvidence();
});

When('用户恢复已暂停的目标', async function (this: LodyWorld) {
  await journeyFor(this).page.resumePausedGoal();
});

Then('Resume 通过带目标元数据的 ACP prompt 恢复目标', async function (this: LodyWorld) {
  await journeyFor(this).page.expectResumedGoalAndPromptEvidence();
});

When('用户重新加载桌面界面并重新打开该 Session', async function (this: LodyWorld) {
  await journeyFor(this).page.reloadDesktopAndReopenGoalSession();
});

Then('更新后的活动目标在界面重载后仍然存在', async function (this: LodyWorld) {
  await journeyFor(this).page.expectUpdatedGoalAfterDesktopReload();
});

When('用户暂停已重载的目标并清理它', async function (this: LodyWorld) {
  await journeyFor(this).page.pauseReloadedGoalAndClearIt();
});

Then('状态机完成暂停到清理且非法后续操作不会留下错误状态', async function (this: LodyWorld) {
  await journeyFor(this).page.expectClearedGoalStateMachineAndNoErrors();
});

When('用户归档并恢复已清理的目标 Session', async function (this: LodyWorld) {
  await journeyFor(this).page.archiveAndRestoreClearedGoalSession();
});

Then(
  '恢复的 Session 保留已清理目标且两个 Session 最终从 UI 中消失',
  async function (this: LodyWorld) {
    await journeyFor(this).page.expectRestoredClearedGoalAndFinalCleanup();
  }
);
