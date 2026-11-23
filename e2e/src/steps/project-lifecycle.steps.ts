import { Given, Then, When } from '@cucumber/cucumber';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import type { LodyWorld } from '../support/world.js';

Given('用户已进入隔离的本地 workspace，且有一个合成 Git 项目', async function (this: LodyWorld) {
  await this.configureProjectLifecycleJourney();
});

When('用户通过项目选择器添加该本地文件夹', async function (this: LodyWorld) {
  await this.projectLifecyclePage!.addProjectThroughProductUi();
});

When('用户从项目选择器重新选择该项目', async function (this: LodyWorld) {
  await this.projectLifecyclePage!.selectProjectFromPicker();
});

When('用户查看原目录安全提示后移除该项目', async function (this: LodyWorld) {
  await this.projectLifecyclePage!.removeProjectAfterReviewingDirectorySafety();
});

Then('该项目从本地 catalog 和项目选择器中消失', async function (this: LodyWorld) {
  await this.projectLifecyclePage!.expectProjectAbsentFromCatalogAndSelector();
});

Then('原项目目录及其合成文件仍然存在', function (this: LodyWorld) {
  const fixture = this.workFixture!;
  expect(existsSync(fixture.projectRoot), 'Project removal deleted the original directory').toBe(
    true
  );
  const readmePath = join(fixture.projectRoot, 'README.md');
  expect(existsSync(readmePath), 'Project removal deleted the original README').toBe(true);
  expect(readFileSync(readmePath, 'utf8')).toContain('Synthetic Lody E2E workspace');
});
