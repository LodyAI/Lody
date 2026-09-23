import { Given, Then, When } from '@cucumber/cucumber';
import type { LodyWorld } from '../support/world.js';

Given('用户已进入一个隔离的本地 workspace', async function (this: LodyWorld) {
  await this.onboarding!.waitForLocalBootstrap();
  await this.onboarding!.skipConfigurationAndEnterProduct();
});

Then('默认命令面板和设置快捷键可用', async function (this: LodyWorld) {
  await this.shortcutPage!.expectDefaultBindings();
});

When('用户打开第二个 workspace 窗口', async function (this: LodyWorld) {
  await this.shortcutPage!.openSecondaryRenderer();
});

Then('第二个窗口中的默认快捷键也可用', async function (this: LodyWorld) {
  await this.shortcutPage!.expectSecondaryDefaultBindings();
});

When('用户把切换侧栏改绑到一个带 Shift 的数字键组合', async function (this: LodyWorld) {
  await this.shortcutPage!.rebindSidebarToggle();
});

Then('两个窗口中的旧绑定都停止生效且新绑定立即生效', async function (this: LodyWorld) {
  await this.shortcutPage!.expectOnlyUserBindingTogglesSidebarInBothRenderers();
});

When('第二个 renderer 重新加载', async function (this: LodyWorld) {
  await this.shortcutPage!.reloadSecondaryRenderer();
});

Then('第二个窗口中的用户改绑仍按相同的物理键生效', async function (this: LodyWorld) {
  await this.shortcutPage!.expectOnlyUserBindingTogglesSidebarInSecondaryRenderer();
});

When('用户用新建标签页快捷键新建两个草稿标签页', async function (this: LodyWorld) {
  await this.shortcutPage!.openDraftSessionTabsWithShortcut(2);
});

When('用户按下切换到第 {int} 个标签页的快捷键', async function (this: LodyWorld, position: number) {
  await this.shortcutPage!.pressSessionTabDigit(position);
});

When('用户按下切换到最后一个标签页的快捷键', async function (this: LodyWorld) {
  await this.shortcutPage!.pressSessionTabDigit(9);
});

Then(
  '会话标签栏的第 {int} 个标签页处于激活状态',
  async function (this: LodyWorld, position: number) {
    await this.shortcutPage!.expectActiveSessionTabPosition(position);
  }
);
