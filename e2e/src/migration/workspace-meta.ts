/** Optional local acceptance: existing catalogs then external Meta, with real UI/ACP and restart. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { ElectronHarness } from '../support/electron-harness.js';
import { OnboardingPage } from '../support/pages/onboarding-page.js';
import { AgentProviderLifecyclePage } from '../support/pages/agent-provider-lifecycle-page.js';
import { PreviewCommentsPage } from '../support/pages/preview-comments-page.js';
import { ScheduledMessagePage } from '../support/pages/scheduled-message-page.js';
import { AgentProviderLifecycleFixture } from '../support/fixtures/agent-provider-lifecycle-fixture.js';

const suiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nativePreview = process.argv.includes('--preview-comments');
const previewBody = 'Synthetic native Preview comment retained';
const resolvedPreviewBody = 'Synthetic native Preview comment resolved';
const nativeDefinitions = process.argv.includes('--schedule-definition');
const scheduledText = 'Synthetic native scheduled message';
const editedScheduledText = 'Synthetic native scheduled message edited';
const nativeSessionBody =
  nativePreview ||
  nativeDefinitions ||
  process.argv.includes('--session-body') ||
  process.env.LODY_E2E_NATIVE_SESSION_BODY === '1';
const base = join(
  suiteRoot,
  'artifacts',
  nativePreview
    ? 'preview-comments-migration'
    : nativeDefinitions
      ? 'schedule-definition-migration'
      : nativeSessionBody
        ? 'session-body-migration'
        : 'workspace-meta-migration'
);
mkdirSync(base, { recursive: true });
const round = mkdtempSync(join(base, 'round-'));
const previewServer = nativePreview
  ? createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html><body style="margin:40px;font-family:sans-serif"><h1>Synthetic Preview target</h1><p>Disposable acceptance content.</p><h2 style="margin-top:180px">Synthetic second target</h2></body></html>'
      );
    })
  : undefined;
let previewTargetFile: string | undefined;
if (previewServer) {
  await new Promise<void>((resolve, reject) => {
    previewServer.once('error', reject);
    previewServer.listen(0, '127.0.0.1', resolve);
  });
  const address = previewServer.address();
  assert.ok(address && typeof address !== 'string');
  previewTargetFile = join(round, 'preview-target.json');
  writeFileSync(
    previewTargetFile,
    JSON.stringify({ protocol: 'http', host: '127.0.0.1', port: address.port, path: '/' })
  );
}
const fixture = new AgentProviderLifecycleFixture(
  join(round, 'acp-events.ndjson'),
  previewTargetFile
);
const savedEnvironment = Object.fromEntries(
  [
    'LODY_NATIVE_MACHINE_CATALOG',
    'LODY_NATIVE_SCHEDULE_REGISTRY',
    'LODY_NATIVE_WORKSPACE_META',
    'LODY_NATIVE_SESSION_BODY',
    'LODY_NATIVE_DOCUMENT_DOMAINS',
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
  sessionBodies?: Record<string, string>;
  scheduleBodies?: { scheduleId: string; stage: string; legacySqlitePresent: boolean }[];
  previewBodies?: { sessionId: string; stage: string; legacySqlitePresent: boolean }[];
  exited?: true;
};
const stages: Stage[] = [];
let profile: string | undefined;
let dataRoot: string | undefined;
const lastHeads = new Map<string, number>();
let failure: unknown;
let legacySessionId: string | undefined;
let nativeMetaSessionId: string | undefined;

async function runStage(
  name: string,
  phase: 'legacy' | 'catalogs' | 'meta',
  action: (page: AgentProviderLifecyclePage) => Promise<void>,
  enableFlag = true
) {
  // Explicit values prevent caller flags from turning the legacy seed into a
  // fresh-native or classic pilot profile. No product build artifacts change.
  const native = phase !== 'legacy';
  const lastNativeHead = lastHeads.get(phase);
  process.env.LODY_NATIVE_MACHINE_CATALOG = native && enableFlag ? '1' : '0';
  process.env.LODY_NATIVE_SCHEDULE_REGISTRY = native && enableFlag ? '1' : '0';
  process.env.LODY_NATIVE_WORKSPACE_META = phase === 'meta' && enableFlag ? '1' : '0';
  process.env.LODY_NATIVE_FILE_INDEX = '0';
  process.env.LODY_NATIVE_DOCUMENT_DOMAINS =
    (nativeDefinitions || nativePreview) && phase === 'meta' && enableFlag ? '1' : '0';
  process.env.LODY_NATIVE_SESSION_BODY =
    nativeSessionBody && phase === 'meta' && enableFlag ? '1' : '0';
  process.env.LODY_NATIVE_WORKSPACE_CATALOG = native && enableFlag ? '1' : '0';
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
        .poll(
          () =>
            phase === 'meta'
              ? harness.captureNativeWorkspaceMetaEvidence()
              : harness.captureNativeMachineCatalogEvidence(),
          { timeout: 60_000 }
        )
        .toEqual([
          expect.objectContaining({
            stage: 'native',
            rendererOwner: 'native',
            head: expect.any(Number),
          }),
        ]);
      const before = (
        phase === 'meta'
          ? harness.captureNativeWorkspaceMetaEvidence()
          : harness.captureNativeMachineCatalogEvidence()
      )[0]!;
      assert.ok(before.head >= before.proofTx && before.proofTx > 0);
      if (lastNativeHead !== undefined) assert.ok(before.head >= lastNativeHead);
    } else {
      assert.deepEqual(harness.captureNativeMachineCatalogEvidence(), []);
      assert.equal(existsSync(join(dataRoot, 'native-repo', 'v1')), false);
      assert.equal(existsSync(join(dataRoot, 'native-repo', 'independent', 'v1')), false);
    }
    if (phase === 'meta' && legacySessionId) {
      const row = harness.page!.locator(`[data-sidebar-session-id="${legacySessionId}"]`);
      await expect(row).toBeVisible({ timeout: 60_000 });
      await row.click();
      await expect(
        harness.page!.getByRole('paragraph').filter({ hasText: fixture.initialResponseText }).last()
      ).toBeVisible({ timeout: 60_000 });
    }
    await action(new AgentProviderLifecyclePage(harness.page!, fixture));
    if (name === 'native-meta-conversation') {
      const match = /#\/local\/sessions\/([^?]+)/u.exec(harness.page!.url());
      assert.ok(match?.[1]);
      nativeMetaSessionId = decodeURIComponent(match[1]);
      assert.notEqual(nativeMetaSessionId, legacySessionId);
      if (nativePreview) {
        const preview = new PreviewCommentsPage(harness.page!);
        await preview.open();
        await preview.add(resolvedPreviewBody, 'Synthetic Preview target');
        await preview.resolve(resolvedPreviewBody);
        await preview.add(previewBody, 'Synthetic second target');
      }
      if (nativeDefinitions) {
        const scheduled = new ScheduledMessagePage(harness.page!);
        await scheduled.create(scheduledText);
        await scheduled.edit(scheduledText, editedScheduledText);
      }
    }
    if (name === 'native-meta-restart') {
      assert.ok(nativeMetaSessionId);
      await harness.page!.locator(`[data-sidebar-session-id="${nativeMetaSessionId}"]`).click();
      await expect(
        harness.page!.getByRole('paragraph').filter({ hasText: fixture.initialResponseText }).last()
      ).toBeVisible();
    }
    if (nativePreview && name === 'native-meta-restart') {
      const preview = new PreviewCommentsPage(harness.page!);
      await preview.open();
      await preview.expectComment(previewBody);
      await preview.expectResolved(resolvedPreviewBody);
    }
    if (nativeDefinitions && name === 'native-meta-restart')
      await new ScheduledMessagePage(harness.page!).expectPending(editedScheduledText);
    if (phase === 'legacy') {
      const match = /#\/local\/sessions\/([^?]+)/u.exec(harness.page!.url());
      assert.ok(match?.[1]);
      legacySessionId = decodeURIComponent(match[1]);
    }
    if (native) {
      assert.equal(harness.captureNativeWorkspaceCatalogEvidence()[0]?.rendererOwner, 'native');
      assert.equal(harness.captureNativeScheduleRegistryEvidence()[0]?.rendererOwner, 'native');
    }
    const catalog =
      (phase === 'meta'
        ? harness.captureNativeWorkspaceMetaEvidence()
        : harness.captureNativeMachineCatalogEvidence())[0] ?? null;
    const nativeEnginePid = native
      ? (harness.captureNativeFileIndexEvidence()[0]?.pid ?? null)
      : null;
    if (native) {
      assert.ok(catalog && nativeEnginePid && nativeEnginePid !== mainPid);
      assert.equal(catalog.stage, 'native');
      assert.equal(catalog.rendererOwner, 'native');
      if (name === 'native-meta-conversation')
        assert.ok(
          catalog.head > (lastNativeHead ?? catalog.proofTx),
          'UI mutation must advance native head'
        );
      lastHeads.set(phase, catalog.head);
    }
    const sessionBodies: Record<string, string> = {};
    if (phase === 'meta' && nativeSessionBody) {
      for (const id of [legacySessionId, nativeMetaSessionId].filter((id): id is string => !!id)) {
        const owner = harness.captureNativeSessionBodyEvidence(accountId, workspaceId, id);
        assert.equal(owner, 'native', `Session ${id} must have a durable native body receipt`);
        sessionBodies[id] = owner;
      }
    }
    const scheduleBodies =
      nativeDefinitions && phase === 'meta'
        ? harness.captureNativeScheduleDefinitionEvidence(accountId, workspaceId)
        : undefined;
    if (scheduleBodies) {
      assert.equal(scheduleBodies.length, 1);
      assert.equal(scheduleBodies[0]!.stage, 'native');
      assert.equal(scheduleBodies[0]!.legacySqlitePresent, false);
      await harness.expectLegacyRendererBodyAbsent(
        workspaceId,
        `schedule-${scheduleBodies[0]!.scheduleId}`
      );
    }
    const previewBodies =
      nativePreview && phase === 'meta'
        ? harness.captureNativePreviewCommentEvidence(accountId, workspaceId)
        : undefined;
    if (previewBodies) {
      assert.equal(previewBodies.length, 1);
      assert.equal(previewBodies[0]!.sessionId, nativeMetaSessionId);
      assert.equal(previewBodies[0]!.stage, 'native');
      assert.equal(previewBodies[0]!.legacySqlitePresent, false);
      await harness.expectLegacyRendererBodyAbsent(
        workspaceId,
        `preview-comment-${nativeMetaSessionId}`
      );
    }
    stage = {
      stage: name,
      accountId,
      workspaceId,
      mainPid,
      daemonPid,
      nativeEnginePid,
      catalog,
      ...(previewBodies ? { previewBodies } : {}),
      ...(scheduleBodies ? { scheduleBodies } : {}),
      ...(nativeSessionBody ? { sessionBodies } : {}),
    };
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
    } catch (error) {
      stageError ??= error;
    } finally {
      harness.writeDiagnostics();
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
  await runStage('legacy-create', 'legacy', async (page) => {
    await page.createProvider();
    await page.sendWithProvider(
      fixture.initialProviderName,
      fixture.firstSessionPrompt,
      fixture.initialResponseText
    );
  });
  await runStage('native-catalogs', 'catalogs', (page) =>
    page.expectProviderListed(fixture.initialProviderName)
  );
  await runStage('native-meta-conversation', 'meta', async (page) => {
    await page.expectProviderListed(fixture.initialProviderName);
    await page.sendWithProvider(
      fixture.initialProviderName,
      fixture.secondSessionPrompt,
      fixture.initialResponseText
    );
    await fixture.expectInitialExecution(fixture.secondSessionPrompt);
  });
  await runStage(
    'native-meta-restart',
    'meta',
    (page) => page.expectProviderListed(fixture.initialProviderName),
    false
  );
} catch (error) {
  failure = error;
} finally {
  if (previewServer)
    await new Promise<void>((resolve, reject) =>
      previewServer.close((error) => (error ? reject(error) : resolve()))
    );
  for (const [name, value] of Object.entries(savedEnvironment))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  writeFileSync(
    join(round, 'result.json'),
    JSON.stringify(
      {
        status: failure ? 'failed' : 'passed',
        sessionBodyAcceptance: nativeSessionBody,
        previewCommentsAcceptance: nativePreview,
        scheduleDefinitionAcceptance: nativeDefinitions,
        scope: nativePreview
          ? 'local real UI/ACP/MCP; new native Preview comments, resolve status mutation and unresolved comment after flag-off restart; durable native publication and no duplicate legacy SQLite/IndexedDB body; no comment body editor, Cloud or cross-platform claim'
          : nativeSessionBody
            ? 'local UI/ACP; complete old Session migration and new native Session creation with durable routes, then flag-off restart; no Cloud or cross-platform claim'
            : 'local UI/ACP with native WF/MF/SR then external Meta; old Session history, new conversation and flag-off restart; Session body remains legacy until separate P4 selection; no Cloud or cross-platform claim',
        stages,
        legacySessionId,
        nativeMetaSessionId,
        retainedProfile: failure ? profile : null,
        failure: failure instanceof Error ? failure.stack : failure ? String(failure) : null,
      },
      null,
      2
    ) + '\n'
  );
  if (!failure && profile) rmSync(profile, { recursive: true, force: true });
}
console.log(`Workspace metadata migration acceptance: ${join(round, 'result.json')}`);
if (failure) throw failure;
