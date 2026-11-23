import { Then, When } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import type { LodyWorld } from '../support/world.js';

const FOLLOW_UP_MARKERS = ['follow-up-1', 'follow-up-2'];

When('用户创建一个已完成首轮回复的 Session', async function (this: LodyWorld) {
  await this.sessionPage!.createCompletedSession(
    'Start the deterministic conversation [MARK:first]'
  );
  this.activeAcpEvent = await this.sessionPage!.waitForMarkedEvent('prompt-end', 'first');
});

When('用户在同一 Session 中逐条发送两条后续消息', async function (this: LodyWorld) {
  // Each send starts while the daemon still holds the finished Session doc.
  for (const marker of FOLLOW_UP_MARKERS) {
    const completed = await this.sessionPage!.sendFollowUpAndAwaitReply(
      marker,
      this.activeAcpEvent!.sessionId!
    );
    expect(completed.stopReason).toBe('end_turn');
  }
});

Then('Agent 按发送顺序各执行每条消息一次', async function (this: LodyWorld) {
  expect(this.sessionPage!.markedPromptStarts(this.activeAcpEvent!.sessionId!)).toEqual([
    'first',
    ...FOLLOW_UP_MARKERS,
  ]);
});
