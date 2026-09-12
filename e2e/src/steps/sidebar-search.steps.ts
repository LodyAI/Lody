import { Given, Then, When } from '@cucumber/cucumber';
import type { LodyWorld } from '../support/world.js';
import { SidebarSearchFixture } from '../support/fixtures/sidebar-search-fixture.js';
import { SidebarSearchPage } from '../support/pages/sidebar-search-page.js';

type SidebarSearchJourney = {
  page: SidebarSearchPage;
};

const journeys = new WeakMap<LodyWorld, SidebarSearchJourney>();

function journeyFor(world: LodyWorld): SidebarSearchJourney {
  const journey = journeys.get(world);
  if (!journey) throw new Error('The sidebar search journey has not been configured');
  return journey;
}

Given('用户已在隔离桌面配置侧栏搜索测试 Agent', async function (this: LodyWorld) {
  if (!this.artifacts || !this.onboarding || !this.harness?.page) {
    throw new Error('Scenario is not ready for sidebar search setup');
  }
  await this.onboarding.waitForLocalBootstrap();
  const fixture = new SidebarSearchFixture(
    `${this.artifacts.scenarioDir}/sidebar-search-scripted-acp.ndjson`
  );
  const page = new SidebarSearchPage(this.harness.page, fixture);
  await this.onboarding.skipConfigurationAndEnterProduct();
  await page.configureAgentFromSettings();
  journeys.set(this, { page });
});

Given(
  '用户通过 New chat 创建了目标、相似标题和不匹配标题的 Session',
  async function (this: LodyWorld) {
    await journeyFor(this).page.createSessionMatrix();
  }
);

When('用户用大小写和部分关键词搜索 Session', async function (this: LodyWorld) {
  await journeyFor(this).page.searchWithCasePartialAndNoMatches();
});

Then('搜索只返回匹配的 Session，清空后完整侧栏列表仍可见', async function (this: LodyWorld) {
  await journeyFor(this).page.expectSidebarListRestoredAfterClearingSearch();
});

When('用户在搜索目标 Session 后将其重命名', async function (this: LodyWorld) {
  await journeyFor(this).page.renameTargetAfterSearching();
});

Then('搜索索引移除旧标题并返回新标题', async function (this: LodyWorld) {
  await journeyFor(this).page.expectRenamedTargetSearchIndex();
});

When('用户从搜索结果打开重命名后的目标 Session', async function (this: LodyWorld) {
  await journeyFor(this).page.findAndOpenRenamedTargetSession();
});

Then('目标 Session 的历史可见', async function (this: LodyWorld) {
  await journeyFor(this).page.expectTargetSessionOpen();
});

When('用户重新载入界面', async function (this: LodyWorld) {
  await journeyFor(this).page.reloadRenderer();
});

Then('已命名的 Session 及其搜索索引在隔离桌面中保持可用', async function (this: LodyWorld) {
  await journeyFor(this).page.expectSessionMatrixPersistsAfterReload();
});

When('用户归档目标 Session', async function (this: LodyWorld) {
  await journeyFor(this).page.archiveTargetSession();
});

Then('搜索索引不再返回归档目标但保留其他匹配 Session', async function (this: LodyWorld) {
  await journeyFor(this).page.expectArchivedTargetRemovedFromSearchIndex();
});

When('用户永久删除归档目标', async function (this: LodyWorld) {
  await journeyFor(this).page.deleteArchivedTargetSession();
});

Then('搜索索引不再返回已删除目标', async function (this: LodyWorld) {
  await journeyFor(this).page.expectDeletedTargetRemovedFromSearchIndex();
});

When('用户从界面永久删除其余搜索 Session', async function (this: LodyWorld) {
  await journeyFor(this).page.deleteRemainingSessions();
});

Then('所有搜索 Session 均已从活动列表和 Archive 中清理', async function (this: LodyWorld) {
  await journeyFor(this).page.expectAllSessionsDeleted();
  await this.harness!.capturePostGcSnapshot();
});
