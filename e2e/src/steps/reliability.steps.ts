import { Given, Then, When } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import type { LodyWorld } from '../support/world.js';

Given('本地数据平面已连接 Renderer', async function (this: LodyWorld) {
  const state = await this.onboarding!.waitForLocalBootstrap();
  expect(state.cli?.runtime?.pid).toEqual(expect.any(Number));
  await this.onboarding!.skipConfigurationAndEnterProduct();
});

When('网络抖动发生在 Renderer 存活检查和 loro.status 广播之间', async function (this: LodyWorld) {
  this.rendererSendRaceResult = await this.harness!.triggerLoroRendererSendRace();
});

Then('Electron 保持运行并在重连后继续响应', function (this: LodyWorld) {
  expect(this.rendererSendRaceResult).toMatchObject({
    disconnected: true,
    electronRunning: true,
    fatalLogExists: false,
    raceTriggered: true,
    reconnected: true,
    rendererResponsive: true,
    targetDestroyed: true,
  });
  expect(this.rendererSendRaceResult!.remainingRendererCount).toBe(
    this.rendererSendRaceResult!.baselineRendererCount
  );
});
