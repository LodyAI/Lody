import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ElectronHarness } from '../../../../e2e/src/support/electron-harness.ts';
import { OnboardingPage } from '../../../../e2e/src/support/pages/onboarding-page.ts';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const artifactsRoot = fileURLToPath(new URL('../../artifacts/visual/', import.meta.url));
const scenarioDir = join(
  artifactsRoot,
  `electron-smoke-${new Date().toISOString().replaceAll(':', '-')}`
);
mkdirSync(scenarioDir, { recursive: true });
const harness = new ElectronHarness({
  rootDir: artifactsRoot,
  scenarioDir,
  stableId: 'STYLE-MIGRATION-ELECTRON-SMOKE',
});
const result: Record<string, unknown> = {
  scope:
    process.env.LODY_STYLE_MIGRATION_PHASE ??
    'After-only real OSS Electron smoke; no pre-migration application baseline',
  command:
    'pnpm --dir e2e exec tsx --tsconfig ../apps/cli/tsconfig.json ../packages/components/tests/visual/electron-smoke.mts',
  startedAt: new Date().toISOString(),
  screenshots: [],
  status: 'running',
};

try {
  result.builtArtifacts = Object.fromEntries(
    ['apps/electron/out/main/index.js', 'apps/electron/out/renderer/index.html'].map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(join(repositoryRoot, path)))
        .digest('hex'),
    ])
  );
  await harness.launch();
  result.isolatedRoot = harness.getIsolatedRoot();
  const page = harness.page!;
  const onboarding = new OnboardingPage(page);
  result.bootstrap = await onboarding.waitForLocalBootstrap();
  const screenshot = async (name: string) => {
    await page.evaluate(() => document.fonts.ready);
    const readiness = await page.evaluate(async () => {
      // TourStill's spring writes transforms from requestAnimationFrame; the
      // screenshot animation switch only settles browser-owned animations.
      let previous = '';
      let stableFrames = 0;
      for (let frame = 0; frame < 240; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const anchor = document.querySelector<HTMLElement>('[data-tour-anchor="window"]');
        const nodes: HTMLElement[] = [];
        const foreground = [...document.querySelectorAll<HTMLElement>('h1, h2, button')].filter(
          (node) => {
            const rect = node.getBoundingClientRect();
            return (
              rect.width > 0 && rect.height > 0 && !node.closest('[data-tour-anchor="window"]')
            );
          }
        );
        for (const target of [anchor, ...foreground])
          for (let node = target, depth = 0; node && depth < 4; node = node.parentElement, depth++)
            if (!nodes.includes(node)) nodes.push(node);
        const pose = nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          const computed = getComputedStyle(node);
          return {
            rect: [rect.x, rect.y, rect.width, rect.height],
            transform: computed.transform,
            opacity: computed.opacity,
            font: computed.font,
            filter: computed.filter,
          };
        });
        const running = document
          .getAnimations()
          .some(
            (animation) =>
              animation.effect?.getTiming().iterations !== Infinity &&
              animation.playState === 'running'
          );
        const current = JSON.stringify(pose);
        stableFrames = !running && current === previous ? stableFrames + 1 : 0;
        previous = current;
        if (stableFrames >= 12) return { frames: frame + 1, tourPose: pose };
      }
      throw new Error('The real onboarding camera or finite animation did not settle');
    });
    await page.screenshot({
      path: join(scenarioDir, name),
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
    const captureReadiness = (result.captureReadiness ??= {}) as Record<string, unknown>;
    captureReadiness[name] = readiness;
    (result.screenshots as string[]).push(name);
  };

  await page
    .getByRole('button', { name: /^(Configure Lody|开始配置)$/u })
    .waitFor({ state: 'visible', timeout: 60_000 });
  await screenshot('electron-onboarding-after.png');
  await onboarding.openAgentConfiguration();
  await screenshot('electron-agent-configuration-after.png');
  await page.getByRole('button', { name: /^(Skip for now|稍后再配置)$/u }).click();
  await page
    .getByRole('heading', { name: /^(Explore Lody|探索 Lody)$/u })
    .waitFor({ state: 'visible' });
  await screenshot('electron-explore-after.png');
  await page.getByRole('button', { name: /^(Enter Lody|进入 Lody)$/u }).click();
  const prompt = page.locator('#chat-prompt');
  await prompt.waitFor({ state: 'visible', timeout: 60_000 });
  if (!(await prompt.isEditable())) throw new Error('The production chat prompt is not editable');
  await screenshot('electron-local-chat-after.png');
  result.url = page.url();
  if (!/#\/local\/chat(?:\?.*)?$/u.test(page.url())) {
    throw new Error(`The desktop did not reach its local chat route: ${page.url()}`);
  }
  result.electronBridge = await page.evaluate(
    () => window.__LODY_ELECTRON__ === true && Boolean(window.ipc)
  );
  if (!result.electronBridge)
    throw new Error('The real Electron preload IPC bridge is unavailable');
  result.snapshot = await harness.captureSnapshot();
  if (process.env.LODY_STYLE_MIGRATION_SCHEDULES === '1') {
    await page
      .getByText(/^(Schedules|日程)$/u, { exact: true })
      .first()
      .click();
    await page
      .getByRole('button', { name: /^(New schedule|新建日程)$/u })
      .first()
      .click();
    const repeat = page.getByRole('combobox', { name: /^(Repeat|重复)$/u });
    await repeat.waitFor({ state: 'visible' });
    await screenshot('electron-schedule-daily.png');
    await repeat.click();
    await page.getByRole('option', { name: /^(Every week|每周)$/u }).click();
    const monday = page.getByRole('button', { name: /^(Monday|星期一|周一)$/u });
    await monday.waitFor({ state: 'visible' });
    const selectedMonday = await monday.getAttribute('aria-pressed');
    await monday.focus();
    await monday.press('Space');
    if ((await monday.getAttribute('aria-pressed')) === selectedMonday)
      throw new Error('The real schedule weekday did not toggle with Space');
    const time = page.locator('input[type="time"]');
    await time.fill('13:45');
    if ((await time.inputValue()) !== '13:45')
      throw new Error('The real schedule time did not retain the edited value');
    await screenshot('electron-schedule-weekly.png');
    await repeat.click();
    await page.getByRole('option', { name: /^(Every month|每月)$/u }).click();
    const lastDay = page.getByRole('button', { name: /^(Day 31|第 31 天|31 日)$/u });
    await lastDay.waitFor({ state: 'visible' });
    const selectedLastDay = await lastDay.getAttribute('aria-pressed');
    await lastDay.click();
    if ((await lastDay.getAttribute('aria-pressed')) === selectedLastDay)
      throw new Error('The real schedule day of month did not toggle');
    await screenshot('electron-schedule-monthly.png');
    result.scheduleUI = {
      url: page.url(),
      weeklyKeyboardToggle: true,
      timeEdit: '13:45',
      monthlyPointerToggle: true,
      persisted: false,
    };
  }
  writeFileSync(
    join(scenarioDir, 'cli-backlog.json'),
    JSON.stringify(await harness.captureCliBacklog(), null, 2)
  );
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.error = error instanceof Error ? error.stack : String(error);
  try {
    await harness.page?.screenshot({
      path: join(scenarioDir, 'electron-failure.png'),
      fullPage: true,
    });
  } catch (screenshotError) {
    result.screenshotError = String(screenshotError);
  }
} finally {
  try {
    await harness.stopTrace(join(scenarioDir, 'trace.zip'));
  } catch (error) {
    result.traceError = String(error);
    result.status = 'failed';
  }
  try {
    harness.writeDiagnostics();
  } catch (error) {
    result.diagnosticsError = String(error);
    result.status = 'failed';
  }
  try {
    await harness.close();
    result.cleanup = 'Production shutdown barrier completed and isolated CLI endpoint released';
  } catch (error) {
    result.cleanupError = String(error);
    result.status = 'failed';
  }
  result.completedAt = new Date().toISOString();
  writeFileSync(join(scenarioDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        scenarioDir,
        status: result.status,
        error: result.error,
        cleanupError: result.cleanupError,
      },
      null,
      2
    )
  );
  if (result.status !== 'passed') process.exitCode = 1;
}
