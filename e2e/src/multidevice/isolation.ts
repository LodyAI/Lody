// A real OSS desktop prerequisite check. Passing this is NOT cloud sync evidence.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ElectronHarness } from '../support/electron-harness.js';
import { OnboardingPage } from '../support/pages/onboarding-page.js';
import { quoteCommandArgument } from '../support/fixtures/command-line.js';
import { SyncSessionUi } from './session-ui.js';

const suiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = join(suiteRoot, 'artifacts', 'multidevice-isolation');
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, 'round-'));
const harnesses = ['a', 'b'].map((id) => {
  const scenarioDir = join(root, id);
  mkdirSync(scenarioDir);
  return new ElectronHarness({ rootDir: root, scenarioDir, stableId: `ISOLATION-${id}` });
});
const signals = join(root, 'signals');
mkdirSync(signals);
const observations: unknown[] = [];
let failure: unknown;
try {
  for (const harness of harnesses) {
    await harness.launch();
    await new OnboardingPage(harness.page!).waitForLocalBootstrap();
    await new OnboardingPage(harness.page!).skipConfigurationAndEnterProduct();
  }
  const observe = async (harness: ElectronHarness) => {
    const main = await harness.app!.evaluate(({ app }) => ({
      pid: process.pid,
      userData: app.getPath('userData'),
      dataDir: process.env.LODY_DATA_DIR!,
      endpoint:
        process.env.LODY_E2E_LOCAL_CLI_HOST_PORT ?? process.env.LODY_E2E_LOCAL_CLI_HOST_PIPE,
    }));
    const state = (await harness.page!.evaluate(async () => ({
      cli: await window.ipc!.invoke('cli.getState'),
      local: await window.ipc!.invoke('localPlatform.getSnapshot'),
    }))) as {
      cli: { runtime: { pid: number; machineId: string }; runtimeOwnership: string };
      local: { userId: string; workspace: { workspaceId: string } };
    };
    assert.equal(state.cli.runtimeOwnership, 'owned');
    assert.ok(state.cli.runtime.pid > 0);
    const database = realpathSync(
      join(main.dataDir, 'loro-repo', state.local.workspace.workspaceId, 'repo.sqlite3')
    );
    return { ...main, ...state, database };
  };
  const a = await observe(harnesses[0]!);
  const b = await observe(harnesses[1]!);
  observations.push(a, b);
  for (const field of ['pid', 'userData', 'dataDir', 'endpoint', 'database'] as const)
    assert.notEqual(a[field], b[field], `Shared ${field}`);
  assert.notEqual(a.cli.runtime.pid, b.cli.runtime.pid);
  assert.notEqual(a.cli.runtime.machineId, b.cli.runtime.machineId);
  assert.notEqual(a.local.userId, b.local.userId);
  assert.notEqual(a.local.workspace.workspaceId, b.local.workspace.workspaceId);
  for (const [i, harness] of harnesses.entries()) {
    const token = `isolated-${i}`;
    const command = [
      process.execPath,
      join(suiteRoot, 'fixtures/sync-scripted-acp.mjs'),
      join(root, `agent-${i}.ndjson`),
      signals,
    ]
      .map(quoteCommandArgument)
      .join(' ');
    const ui = new SyncSessionUi(harness.page!);
    await ui.configureAgent(command);
    await ui.send(token, true);
    await ui.expectStreaming(token);
    writeFileSync(join(signals, token), 'release\n', { flag: 'wx' });
    await ui.expectHistory([token]);
    const url = harness.page!.url();
    const profile = harness.getIsolatedRoot();
    await harness.stopTrace(join(harness.artifacts.scenarioDir, 'before-restart.zip'));
    await harness.close({ preserveRoot: true });
    await harness.launch({ reuseRoot: profile });
    await harness.page!.goto(url);
    await new SyncSessionUi(harness.page!).expectHistory([token]);
    const restarted = await observe(harness);
    const previous = i === 0 ? a : b;
    assert.notEqual(restarted.pid, previous.pid);
    assert.notEqual(restarted.cli.runtime.pid, previous.cli.runtime.pid);
    assert.equal(restarted.cli.runtime.machineId, previous.cli.runtime.machineId);
    assert.equal(restarted.local.userId, previous.local.userId);
    assert.equal(restarted.local.workspace.workspaceId, previous.local.workspace.workspaceId);
    assert.equal(restarted.database, previous.database);
    observations.push({ stage: 'restarted', device: i, ...restarted });
    await harness.page!.screenshot({
      path: join(harness.artifacts.scenarioDir, 'restarted.png'),
      fullPage: true,
    });
  }
} catch (error) {
  failure = error;
} finally {
  for (const harness of harnesses) {
    for (const capture of [
      async () => {
        if (harness.app && harness.page) await harness.captureSnapshot();
      },
      async () => {
        if (harness.page)
          writeFileSync(
            join(harness.artifacts.scenarioDir, 'cli-backlog.json'),
            JSON.stringify(await harness.captureCliBacklog())
          );
      },
      async () => {
        if (harness.page)
          await harness.page.screenshot({
            path: join(harness.artifacts.scenarioDir, 'final.png'),
            fullPage: true,
          });
      },
      async () => {
        await harness.stopTrace(join(harness.artifacts.scenarioDir, 'trace.zip'));
      },
      async () => {
        harness.writeDiagnostics();
      },
      async () => {
        await harness.close();
      },
    ]) {
      try {
        await capture();
      } catch (error) {
        failure = failure
          ? new AggregateError([failure, error], 'Isolation and cleanup failure')
          : error;
      }
    }
  }
}
writeFileSync(
  join(root, 'result.json'),
  JSON.stringify(
    {
      status: failure ? 'failed' : 'isolation-passed',
      cloudSync: 'unmeasured',
      observations,
      error: failure ? String(failure) : undefined,
    },
    null,
    2
  ) + '\n'
);
console.log(`Independent-profile evidence: ${root}`);
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
