/** Optional local acceptance: UI-authored legacy WF -> native, using one disposable profile. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { ElectronHarness } from '../support/electron-harness.js';
import { OnboardingPage } from '../support/pages/onboarding-page.js';
import { McpCatalogEditingPage } from '../support/pages/mcp-catalog-editing-page.js';
import { McpCatalogEditingFixture } from '../support/fixtures/mcp-catalog-editing-fixture.js';

const suiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = join(suiteRoot, 'artifacts', 'workspace-catalog-migration');
mkdirSync(base, { recursive: true });
const round = mkdtempSync(join(base, 'round-'));
const fixture = new McpCatalogEditingFixture();
const savedEnvironment = Object.fromEntries(
  ['LODY_NATIVE_WORKSPACE_CATALOG', 'LODY_NATIVE_FILE_INDEX', 'LODY_NATIVE_REPO_MODE'].map(
    (name) => [name, process.env[name]]
  )
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
type Evidence = ReturnType<ElectronHarness['captureNativeWorkspaceCatalogEvidence']>[number];
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
  action: (page: McpCatalogEditingPage) => Promise<void>
) {
  // Explicit values prevent caller flags from turning the legacy seed into a
  // fresh-native or classic pilot profile. No product build artifacts change.
  process.env.LODY_NATIVE_WORKSPACE_CATALOG = native ? '1' : '0';
  process.env.LODY_NATIVE_FILE_INDEX = '0';
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
        .poll(() => harness.captureNativeWorkspaceCatalogEvidence(), { timeout: 60_000 })
        .toEqual([
          expect.objectContaining({
            stage: 'native',
            rendererOwner: 'native',
            head: expect.any(Number),
          }),
        ]);
      const before = harness.captureNativeWorkspaceCatalogEvidence()[0]!;
      assert.ok(before.head >= before.proofTx && before.proofTx > 0);
      if (lastNativeHead !== undefined) assert.equal(before.head, lastNativeHead);
    } else {
      assert.deepEqual(harness.captureNativeWorkspaceCatalogEvidence(), []);
      assert.equal(existsSync(join(dataRoot, 'native-repo', 'v1')), false);
      assert.equal(existsSync(join(dataRoot, 'native-repo', 'independent', 'v1')), false);
    }
    await action(new McpCatalogEditingPage(harness.page!, fixture));
    const catalog = harness.captureNativeWorkspaceCatalogEvidence()[0] ?? null;
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
    await page.createDefaultEnabledServer();
    await page.expectInitialEntryPersisted();
  });
  await runStage('native-edit', true, async (page) => {
    await page.expectInitialEntryPersisted();
    await page.editServer();
    await page.expectEditedEntryPersisted();
  });
  await runStage('native-delete', true, async (page) => {
    await page.expectEditedEntryPersisted();
    await page.deleteServer();
    await page.expectDeletedEntryPersisted();
  });
  await runStage('native-deleted-restart', true, (page) => page.expectDeletedEntryPersisted());
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
          'local UI-authored legacy WF to native; no cloud, Session, Meta or cross-platform claim',
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
console.log(`Workspace catalog migration acceptance: ${join(round, 'result.json')}`);
if (failure) throw failure;
