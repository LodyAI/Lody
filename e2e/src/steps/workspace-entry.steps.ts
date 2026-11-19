import { Given } from '@cucumber/cucumber';
import type { LodyWorld } from '../support/world.js';
import { activeDesktopTarget } from '../support/target.js';

Given('桌面已进入一个可用的工作区', async function (this: LodyWorld) {
  await activeDesktopTarget().enterUsableWorkspace(this);
});
