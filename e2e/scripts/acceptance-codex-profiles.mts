import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, cpSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { ManagedAgentRuntimeManager } from '../../apps/cli/src/agent/managed-agent-runtime.js';
import { DEFAULT_RUNTIME_ARTIFACTS_BASE_URL } from '../../packages/platform/src/runtime-artifacts.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ElectronHarness } from '../src/support/electron-harness.js';
import { OnboardingPage } from '../src/support/pages/onboarding-page.js';
import { createCodexExternalFixture } from '../fixtures/codex-external-wire.mjs';

if (process.platform !== 'darwin')
  throw new Error('Codex credential acceptance currently requires a macOS user keychain.');
const root = resolve(import.meta.dirname, '../..');
const runtimeRoot = process.env.LODY_CODEX_ACCEPTANCE_RUNTIME_DIR;
if (!runtimeRoot)
  throw new Error(
    'Set LODY_CODEX_ACCEPTANCE_RUNTIME_DIR to an isolated managed-runtime cache directory.'
  );
const runtimeManager = new ManagedAgentRuntimeManager({
  rootDir: resolve(runtimeRoot),
  runtimeBaseUrl: DEFAULT_RUNTIME_ARTIFACTS_BASE_URL,
  fetchImpl: fetch,
});
const runtime = await runtimeManager.ensureCurrentRuntime('codex');
const runtimeCommand = relative(resolve(runtimeRoot), runtime.command);
const require = createRequire(resolve(root, 'e2e/package.json'));
const { _electron, expect } = require('@playwright/test');
const artifacts = resolve(
  root,
  'e2e/artifacts/acceptance',
  `codex-profiles-${new Date().toISOString().replace(/[:.]/g, '-')}`
);
mkdirSync(artifacts, { recursive: true });
const external = await createCodexExternalFixture(resolve(artifacts, 'external-fixture'));
const apiEvents: { path?: string; authorized: boolean; stream?: boolean }[] = [];
const api = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    const authorized = request.headers.authorization === 'Bearer lody-acceptance-synthetic-api-key';
    const input = body ? JSON.parse(body) : {};
    apiEvents.push({ path: request.url, authorized, stream: input.stream });
    if (!authorized) {
      response.writeHead(401).end('{"error":"Synthetic invalid key"}');
      return;
    }
    if (request.url === '/v1/models') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.4', object: 'model' }] }));
      return;
    }
    const text = 'Verified custom API connection on this machine.';
    const item = {
      id: 'synthetic-message',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    };
    const result = {
      id: 'synthetic-response',
      object: 'response',
      status: 'completed',
      output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    if (!input.stream) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    for (const event of [
      { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      },
      {
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: result },
    ])
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  })().catch(() => {
    response.writeHead(500).end();
  });
});
api.listen(0, '127.0.0.1');
await once(api, 'listening');
const address = api.address();
if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
const apiUrl = `http://127.0.0.1:${address.port}/v1`;
const originalLaunch = _electron.launch.bind(_electron);
_electron.launch = (options: { env: Record<string, string> }) => {
  cpSync(resolve(runtimeRoot), resolve(options.env.LODY_DATA_DIR, 'agent-binaries'), {
    recursive: true,
  });
  const legacyHome = resolve(options.env.LODY_DATA_DIR, 'isolated-legacy-native-home');
  mkdirSync(legacyHome, { recursive: true });
  return originalLaunch({
    ...options,
    env: { ...options.env, ...external.env, CODEX_HOME: legacyHome },
    recordVideo: { dir: artifacts, size: { width: 1280, height: 800 } },
  });
};
const harness = new ElectronHarness({
  rootDir: artifacts,
  scenarioDir: artifacts,
  stableId: 'LODY-CODEX-AFTER-001',
});
let video: ReturnType<NonNullable<ElectronHarness['page']>['video']> = null;
try {
  await harness.launch();
  const page = harness.page!;
  video = page.video();
  await page.setViewportSize({ width: 1280, height: 800 });
  const onboarding = new OnboardingPage(page);
  await onboarding.waitForLocalBootstrap();
  await onboarding.skipConfigurationAndEnterProduct();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('navigation', { name: /^(Settings|设置)$/u }) });
  await settings.locator('[data-settings-tab-id="agents"]').click();
  await settings
    .getByRole('button', { name: /^(Add provider|添加 Provider)$/u })
    .first()
    .click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'ChatGPT', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Custom API', exact: true }).click();
  await page.locator('#agent-config-name').fill('Codex · Custom API');
  await page.locator('#codex-base-url').fill(apiUrl);
  await page.screenshot({ path: resolve(artifacts, '01-custom-api-form.png') });
  writeFileSync(resolve(artifacts, '01-form.txt'), await page.locator('body').ariaSnapshot());
  await page.getByRole('button', { name: /^(Continue|Create|继续|创建)$/u }).click();
  await page
    .getByRole('button', { name: /^(Sign in with ChatGPT|Enter API Key|Sign in)$/u })
    .click({ timeout: 60000 });
  await expect(page.locator('input[type="password"]')).toBeVisible({ timeout: 60000 });
  await page.locator('input[type="password"]').fill('lody-acceptance-synthetic-api-key');
  writeFileSync(
    resolve(artifacts, '02-secret-input.txt'),
    await page.locator('body').ariaSnapshot()
  );
  await page.screenshot({ path: resolve(artifacts, '02-api-secret-input.png') });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Edit Config', exact: true })).toHaveCount(1, {
    timeout: 60000,
  });
  await expect
    .poll(() => apiEvents.some((event) => event.path === '/v1/responses' && event.authorized), {
      timeout: 10000,
    })
    .toBe(true);
  await page.screenshot({ path: resolve(artifacts, '03-api-ready.png') });
  writeFileSync(resolve(artifacts, '03-api-ready.txt'), await page.locator('body').ariaSnapshot());
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('#chat-prompt').fill('Verify the isolated custom API connection.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.getByText('Verified custom API connection on this machine.', { exact: true }).last()
  ).toBeVisible({ timeout: 60000 });
  await page.screenshot({ path: resolve(artifacts, '04-api-session.png') });
  console.log('API provider and actual model session passed');
  await page
    .getByRole('button', { name: /^(Home|New chat)$/u })
    .first()
    .click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings.locator('[data-settings-tab-id="agents"]').click();
  for (const number of [1, 2]) {
    await settings.getByRole('button', { name: 'Add provider', exact: true }).first().click();
    await page.getByRole('option', { name: 'Codex', exact: true }).click();
    await page.locator('#agent-config-name').fill(`Codex · Account ${number === 1 ? 'A' : 'B'}`);
    await expect(page.getByRole('tab', { name: 'ChatGPT', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await page.getByRole('button', { name: /^(Continue|Create)$/u }).click();
    await expect(page.getByRole('dialog', { name: 'New provider', exact: true })).toBeHidden({
      timeout: 10000,
    });
    writeFileSync(
      resolve(artifacts, `chatgpt-${number}-pending.txt`),
      await page.locator('body').ariaSnapshot()
    );
    await page
      .getByRole('button', { name: 'Sign in with ChatGPT', exact: true })
      .click({ timeout: 60000 });
    const code = `LODY-${String(number).padStart(4, '0')}`;
    await expect(page.getByText(code, { exact: true })).toBeVisible({ timeout: 60000 });
    await page.screenshot({ path: resolve(artifacts, `05-device-login-${number}.png`) });
    external.approve(code);
    await expect(settings.getByRole('button', { name: 'Edit Config', exact: true })).toHaveCount(
      number + 1,
      { timeout: 60000 }
    );
  }
  await page.screenshot({ path: resolve(artifacts, '06-three-ready-providers.png') });
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  for (const number of [1, 2]) {
    if (number === 2)
      await page
        .getByRole('button', { name: /^(Home|New chat)$/u })
        .first()
        .click();
    await page.getByRole('button', { name: 'Run configuration', exact: true }).click();
    const submenu = page.getByRole('menuitem', { name: /^Agent(?:\s|$)/u });
    await submenu.hover();
    const option = page.getByRole('menuitemradio', {
      name: `Codex · Account ${number === 1 ? 'A' : 'B'}`,
      exact: true,
    });
    await expect(option).toBeVisible();
    const bounds = await option.boundingBox();
    if (!bounds) throw new Error('Provider choice is not rendered');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 8 });
    await option.click();
    await page.keyboard.press('Escape');
    if (await submenu.isVisible()) await page.keyboard.press('Escape');
    await page.locator('#chat-prompt').fill(`Verify isolated account ${number}.`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(
      page
        .getByText(`Verified isolated ChatGPT synthetic-account-${number}.`, { exact: true })
        .last()
    ).toBeVisible({ timeout: 60000 });
    await page.screenshot({ path: resolve(artifacts, `07-account-${number}-session.png`) });
  }
  console.log('Two native ChatGPT account sessions passed');
  const priorARequests = external.events.filter(
    (event) => event.path?.endsWith('/responses') && event.account === 'synthetic-account-1'
  ).length;
  await page.getByText('Verify isolated account 1.', { exact: true }).first().click();
  await page
    .getByRole('combobox', { name: 'Message', exact: true })
    .fill('Confirm account A is unchanged after account B signed in.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect
    .poll(
      () =>
        external.events.filter(
          (event) => event.path?.endsWith('/responses') && event.account === 'synthetic-account-1'
        ).length,
      { timeout: 60000 }
    )
    .toBeGreaterThan(priorARequests);
  await expect(
    page.getByText('Verified isolated ChatGPT synthetic-account-1.', { exact: true }).last()
  ).toBeVisible({ timeout: 60000 });
  await page.screenshot({ path: resolve(artifacts, '08-account-a-still-bound.png') });
  const concurrentPrompts = [
    'Synthetic parallel account A first.',
    'Synthetic parallel account A second.',
  ];
  const barrier = external.holdResponses('synthetic-account-1', concurrentPrompts);
  for (const [index, prompt] of concurrentPrompts.entries()) {
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('button', { name: 'Run configuration', exact: true }).click();
    const menu = page.getByRole('menuitem', { name: /^Agent(?:\s|$)/u });
    await menu.hover();
    const choice = page.getByRole('menuitemradio', { name: 'Codex · Account A', exact: true });
    await expect(choice).toBeVisible();
    const bounds = await choice.boundingBox();
    if (!bounds) throw new Error('Account A choice is not rendered');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 8 });
    await choice.click();
    await page.keyboard.press('Escape');
    if (await menu.isVisible()) await page.keyboard.press('Escape');
    await page.locator('#chat-prompt').fill(prompt);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => barrier.arrived.length, { timeout: 60000 }).toBe(index + 1);
  }
  await page.screenshot({ path: resolve(artifacts, '08b-same-account-overlapping.png') });
  barrier.release();
  await expect(
    page.getByText('Verified isolated ChatGPT synthetic-account-1.', { exact: true }).last()
  ).toBeVisible({ timeout: 60000 });
  await page.getByText(concurrentPrompts[0], { exact: true }).first().click();
  await expect(
    page.getByText('Verified isolated ChatGPT synthetic-account-1.', { exact: true }).last()
  ).toBeVisible({ timeout: 60000 });
  await page.screenshot({ path: resolve(artifacts, '08c-same-account-both-completed.png') });
  console.log('Same ChatGPT profile: two overlapping native requests completed');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings.locator('[data-settings-tab-id="agents"]').click();
  await settings
    .getByRole('button', { name: 'Edit Config', exact: true })
    .filter({ hasText: 'Codex · Custom API' })
    .click();
  writeFileSync(resolve(artifacts, '09-api-edit.txt'), await page.locator('body').ariaSnapshot());
  await page.getByRole('button', { name: 'Update API Key', exact: true }).click();
  await page.locator('input[type="password"]').fill('lody-acceptance-invalid-replacement');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    page.getByText('Codex endpoint could not verify this API Key', { exact: false })
  ).toBeVisible({ timeout: 60000 });
  await page.screenshot({ path: resolve(artifacts, '10-rejected-key-replacement.png') });
  writeFileSync(
    resolve(artifacts, '10-rejected-key-replacement.txt'),
    await page.locator('body').ariaSnapshot()
  );
  console.log('Invalid key replacement rejected');
  await page
    .getByRole('dialog', { name: 'Edit Codex', exact: true })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('button', { name: 'Run configuration', exact: true }).click();
  const agentMenu = page.getByRole('menuitem', { name: /^Agent(?:\s|$)/u });
  await agentMenu.hover();
  const apiOption = page.getByRole('menuitemradio', { name: 'Codex · Custom API', exact: true });
  await expect(apiOption).toBeVisible();
  const apiBounds = await apiOption.boundingBox();
  if (!apiBounds) throw new Error('API provider choice is not rendered');
  await page.mouse.move(apiBounds.x + apiBounds.width / 2, apiBounds.y + apiBounds.height / 2, {
    steps: 8,
  });
  await apiOption.click();
  await page.keyboard.press('Escape');
  if (await agentMenu.isVisible()) await page.keyboard.press('Escape');
  await page
    .locator('#chat-prompt')
    .fill('Verify the original key still works after a rejected replacement.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.getByText('Verified custom API connection on this machine.', { exact: true }).last()
  ).toBeVisible({ timeout: 60000 });
  await page.screenshot({ path: resolve(artifacts, '11-original-key-still-works.png') });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings.locator('[data-settings-tab-id="agents"]').click();
  const apiRow = settings
    .getByRole('button', { name: 'Edit Config', exact: true })
    .filter({ hasText: 'Codex · Custom API' })
    .locator('..');
  await apiRow.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Edit Config', exact: true })).toHaveCount(2);
  const profileDirectory = resolve(harness.getIsolatedRoot(), 'lody-data/codex-profiles');
  for (const entry of readdirSync(profileDirectory, { withFileTypes: true })) {
    if (entry.isDirectory())
      expect(existsSync(resolve(profileDirectory, entry.name, 'home/auth.json'))).toBe(false);
  }
  const apiRecordFile = readdirSync(profileDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(profileDirectory, entry.name, 'profile.json'))
    .find(
      (file) =>
        existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).profile.mode === 'api-key'
    );
  if (!apiRecordFile) throw new Error('API profile evidence missing');
  await expect
    .poll(() => JSON.parse(readFileSync(apiRecordFile, 'utf8')).credentialsRemoved, {
      timeout: 15000,
    })
    .toBe(true);
  await page.screenshot({
    path: resolve(artifacts, '12-api-deleted-chatgpt-accounts-retained.png'),
  });
  writeFileSync(
    resolve(artifacts, 'result.json'),
    JSON.stringify(
      {
        status: 'passed',
        apiLogin: true,
        chatgptAccounts: 2,
        accountAResumed: true,
        sameAccountConcurrentRequests: 2,
        invalidReplacementPreservesWorkingKey: true,
        apiDeleteCleansVault: true,
      },
      null,
      2
    )
  );
  console.log('Original key retained; UI deletion cleaned profile credentials');
} catch (error) {
  if (harness.page) {
    writeFileSync(
      resolve(artifacts, 'failure.txt'),
      await harness.page.locator('body').ariaSnapshot()
    );
    await harness.page.screenshot({ path: resolve(artifacts, 'failure.png') });
  }
  throw error;
} finally {
  writeFileSync(
    resolve(artifacts, 'fixture-events.json'),
    JSON.stringify({ apiEvents, authEvents: external.events }, null, 2)
  );
  harness.writeDiagnostics();
  await harness.stopTrace(resolve(artifacts, 'trace.zip'));
  let isolatedRoot: string | undefined;
  try {
    isolatedRoot = harness.getIsolatedRoot();
  } catch {
    /* Launch may have failed before allocating its root. */
  }
  await harness.close({ preserveRoot: true });
  try {
    if (isolatedRoot) {
      const profileRoot = resolve(isolatedRoot, 'lody-data/codex-profiles');
      const cleanup: { profileId: string; mode: string; removed: boolean }[] = [];
      if (existsSync(profileRoot)) {
        for (const entry of readdirSync(profileRoot, { withFileTypes: true })) {
          const recordFile = resolve(profileRoot, entry.name, 'profile.json');
          if (!entry.isDirectory() || !existsSync(recordFile)) continue;
          const record = JSON.parse(readFileSync(recordFile, 'utf8'));
          let removed = true;
          const owner = createHash('sha256')
            .update(JSON.stringify([record.workspaceId, record.machineId, record.configId]))
            .digest('hex');
          for (const generation of record.generations) {
            try {
              execFileSync(
                '/usr/bin/security',
                [
                  'delete-generic-password',
                  '-s',
                  'Lody Codex Profiles',
                  '-a',
                  `${owner}:${record.profile.profileId}:${generation}`,
                ],
                { stdio: 'pipe' }
              );
            } catch (error) {
              if ((error as { status?: number }).status !== 44) {
                removed = false;
                process.exitCode = 1;
              }
            }
          }
          if (record.profile.mode === 'chatgpt') {
            await promisify(execFile)(
              resolve(isolatedRoot, 'lody-data/agent-binaries', runtimeCommand),
              ['-c', 'cli_auth_credentials_store="keyring"', 'logout'],
              {
                cwd: isolatedRoot,
                env: {
                  PATH: '/usr/bin:/bin',
                  HOME: process.env.HOME,
                  CODEX_HOME: resolve(profileRoot, entry.name, 'home'),
                  ...external.env,
                },
                timeout: 20000,
              }
            );
          }
          cleanup.push({
            profileId: record.profile.profileId,
            mode: record.profile.mode,
            removed,
          });
        }
      }
      writeFileSync(
        resolve(artifacts, 'cleanup.json'),
        JSON.stringify({ isolatedRoot, cleanup }, null, 2)
      );
    }
  } finally {
    try {
      if (video) await video.saveAs(resolve(artifacts, 'after.webm'));
    } finally {
      api.closeAllConnections();
      api.close();
      await external.close();
    }
  }
}
console.log(artifacts);
