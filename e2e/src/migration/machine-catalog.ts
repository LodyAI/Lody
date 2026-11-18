/** Optional local acceptance: UI-authored legacy MF -> native, using one disposable profile. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { ElectronHarness } from '../support/electron-harness.js';
import { OnboardingPage } from '../support/pages/onboarding-page.js';
import { AgentProviderLifecyclePage } from '../support/pages/agent-provider-lifecycle-page.js';
import { AgentProviderLifecycleFixture } from '../support/fixtures/agent-provider-lifecycle-fixture.js';

const suiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = join(suiteRoot, 'artifacts', 'machine-catalog-migration');
mkdirSync(base, { recursive: true });
const round = mkdtempSync(join(base, 'round-'));
const fixture = new AgentProviderLifecycleFixture(join(round, 'acp-events.ndjson'));
const savedEnvironment = Object.fromEntries(
  [
    'LODY_NATIVE_MACHINE_CATALOG',
    'LODY_NATIVE_WORKSPACE_CATALOG',
    'LODY_NATIVE_FILE_INDEX',
    'LODY_NATIVE_REPO_MODE',
  ].map((name) => [name, process.env[name]])
);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0); // Passive check of this disposable profile's recorded PID only.
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};
type Evidence = ReturnType<ElectronHarness['captureNativeMachineCatalogEvidence']>[number];
type Stage = {
  stage: string;
  accountId: string;
  workspaceId: string;
  mainPid: number;
  daemonPid: number;
  nativeEnginePid: number | null;
  catalog: Evidence | null;
  exited?: true;
};
const stages: Stage[] = [];
let profile: string | undefined;
let dataRoot: string | undefined;
let lastNativeHead: number | undefined;
let failure: unknown;

async function runStage(
  name: string,
  native: boolean,
  action: (page: AgentProviderLifecyclePage) => Promise<void>,
  enableFlag = native
) {
  // Explicit values prevent caller flags from turning the legacy seed into a
  // fresh-native or classic pilot profile. No product build artifacts change.
  process.env.LODY_NATIVE_MACHINE_CATALOG = enableFlag ? '1' : '0';
  process.env.LODY_NATIVE_FILE_INDEX = '0';
  process.env.LODY_NATIVE_WORKSPACE_CATALOG = '0';
  process.env.LODY_NATIVE_REPO_MODE = '';
  const scenarioDir = join(round, name);
  mkdirSync(scenarioDir);
  const harness = new ElectronHarness({ rootDir: round, scenarioDir, stableId: name });
  let stage: Stage | undefined;
  let stageError: unknown;
  try {
    await harness.launch(profile ? { reuseRoot: profile } : {});
    const onboarding = new OnboardingPage(harness.page!);
    const bootstrap = await onboarding.waitForLocalBootstrap();
    if (!profile) {
      profile = harness.getIsolatedRoot();
      await onboarding.skipConfigurationAndEnterProduct();
    } else {
      await expect(harness.page!.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
    }
    const currentDataRoot = await harness.app!.evaluate(() => process.env.LODY_DATA_DIR!);
    if (dataRoot) assert.equal(currentDataRoot, dataRoot);
    dataRoot = currentDataRoot;
    const mainPid = harness.app!.process().pid;
    const daemonPid = bootstrap.cli?.runtime?.pid;
    const accountId = bootstrap.snapshot?.userId;
    const workspaceId = bootstrap.snapshot?.workspace?.workspaceId;
    assert.ok(mainPid && daemonPid && accountId && workspaceId);
    if (stages[0]) {
      assert.equal(accountId, stages[0].accountId);
      assert.equal(workspaceId, stages[0].workspaceId);
      assert.notEqual(mainPid, stages.at(-1)!.mainPid);
      assert.notEqual(daemonPid, stages.at(-1)!.daemonPid);
    }
    if (native) {
      await expect
        .poll(() => harness.captureNativeMachineCatalogEvidence(), { timeout: 60_000 })
        .toEqual([
          expect.objectContaining({
            stage: 'native',
            rendererOwner: 'native',
            head: expect.any(Number),
          }),
        ]);
      const before = harness.captureNativeMachineCatalogEvidence()[0]!;
      assert.ok(before.head >= before.proofTx && before.proofTx > 0);
      if (lastNativeHead !== undefined) assert.ok(before.head >= lastNativeHead);
    } else {
      assert.deepEqual(harness.captureNativeMachineCatalogEvidence(), []);
      assert.equal(existsSync(join(dataRoot, 'native-repo', 'v1')), false);
      assert.equal(existsSync(join(dataRoot, 'native-repo', 'independent', 'v1')), false);
    }
    await action(new AgentProviderLifecyclePage(harness.page!, fixture));
    const catalog = harness.captureNativeMachineCatalogEvidence()[0] ?? null;
    const nativeEnginePid = native
      ? (harness.captureNativeFileIndexEvidence()[0]?.pid ?? null)
      : null;
    if (native) {
      assert.ok(catalog && nativeEnginePid && nativeEnginePid !== mainPid);
      assert.equal(catalog.stage, 'native');
      assert.equal(catalog.rendererOwner, 'native');
      if (name !== 'native-deleted-restart')
        assert.ok(
          catalog.head > (lastNativeHead ?? catalog.proofTx),
          'UI mutation must advance native head'
        );
      lastNativeHead = catalog.head;
    }
    stage = { stage: name, accountId, workspaceId, mainPid, daemonPid, nativeEnginePid, catalog };
    stages.push(stage);
    await harness.page!.screenshot({ path: join(scenarioDir, 'checkpoint.png'), fullPage: true });
  } catch (error) {
    stageError = error;
    if (harness.page)
      await harness.page
        .screenshot({ path: join(scenarioDir, 'failure.png'), fullPage: true })
        .catch(() => {});
  } finally {
    try {
      if (harness.app && harness.page) {
        await harness.captureSnapshot();
        writeFileSync(
          join(scenarioDir, 'cli-backlog.json'),
          JSON.stringify(await harness.captureCliBacklog())
        );
      }
      await harness.stopTrace(join(scenarioDir, 'trace.zip'));
      harness.writeDiagnostics();
    } catch (error) {
      stageError ??= error;
    }
    try {
      await harness.close({ preserveRoot: true });
      if (stage) {
        for (const pid of [stage.mainPid, stage.daemonPid, stage.nativeEnginePid].filter(
          (pid): pid is number => pid !== null
        ))
          await expect.poll(() => alive(pid), { timeout: 20_000 }).toBe(false);
        stage.exited = true;
      }
    } catch (error) {
      stageError ??= error;
    }
  }
  if (stageError) throw stageError;
}

try {
  await runStage('legacy-create', false, async (page) => {
    await page.createProvider();
    await page.expectProviderListed(fixture.initialProviderName);
  });
  await runStage('native-edit', true, async (page) => {
    await page.expectProviderListed(fixture.initialProviderName);
    await page.renameProvider(fixture.initialProviderName, fixture.editedProviderName);
    await page.sendWithProvider(
      fixture.editedProviderName,
      fixture.firstSessionPrompt,
      fixture.initialResponseText
    );
    await fixture.expectInitialExecution(fixture.firstSessionPrompt);
  });
  await runStage('native-delete', true, async (page) => {
    await page.expectProviderListed(fixture.editedProviderName);
    await page.deleteProviderByName(fixture.editedProviderName);
    await page.expectProviderListed(fixture.editedProviderName, false);
  });
  await runStage(
    'native-deleted-restart',
    true,
    (page) => page.expectProviderListed(fixture.editedProviderName, false),
    false
  );
} catch (error) {
  failure = error;
} finally {
  for (const [name, value] of Object.entries(savedEnvironment))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  writeFileSync(
    join(round, 'result.json'),
    JSON.stringify(
      {
        status: failure ? 'failed' : 'passed',
        scope:
          'local UI-authored legacy MF to native; private launch/prompt preserved by actual ACP conversation; no native Session body, cloud or cross-platform claim',
        stages,
        retainedProfile: failure ? profile : null,
        failure: failure instanceof Error ? failure.stack : failure ? String(failure) : null,
      },
      null,
      2
    ) + '\n'
  );
  if (!failure && profile) rmSync(profile, { recursive: true, force: true });
}
console.log(`Machine catalog migration acceptance: ${join(round, 'result.json')}`);
if (failure) throw failure;
