import { Given, Then, When } from '@cucumber/cucumber';
import type { LodyWorld } from '../support/world.js';

Given('用户已在隔离桌面配置未读状态测试 Agent', async function (this: LodyWorld) {
  await this.configureSessionReadStateJourney();
});

Given('用户通过 New chat 创建了两个 Session', async function (this: LodyWorld) {
  await this.sessionReadStatePage!.createTwoSessions();
});

When('用户在第二个 Session 中将第一个标记为未读', async function (this: LodyWorld) {
  await this.sessionReadStatePage!.markFirstSessionUnread();
});

Then('第一个 Session 显示未读状态', async function (this: LodyWorld) {
  await this.sessionReadStatePage!.expectUnreadIndicator();
});

When('用户从侧栏打开第一个 Session', async function (this: LodyWorld) {
  await this.sessionReadStatePage!.openFirstSession();
});

Then('其历史可见且未读状态被清除', async function (this: LodyWorld) {
  await this.sessionReadStatePage!.expectUnreadCleared();
});

When('用户从界面永久删除两个 Session', async function (this: LodyWorld) {
  await this.sessionReadStatePage!.deleteBothSessions();
});

Then('两个 Session 均已从活动列表和 Archive 中清理', async function (this: LodyWorld) {
  await this.sessionReadStatePage!.expectBothSessionsDeleted();
});
