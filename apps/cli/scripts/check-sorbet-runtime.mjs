import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';

const cliRoot = resolve(import.meta.dirname, '..');
const outputDirectoryFlag = process.argv.indexOf('--output-dir');
const outputDirectory = outputDirectoryFlag === -1 ? 'dist' : process.argv[outputDirectoryFlag + 1];
assert(outputDirectory, '--output-dir requires a path');
const outputRoot = resolve(cliRoot, outputDirectory);
const entry = join(outputRoot, 'sorbet/dist/stdio-cli.js');
const worker = join(outputRoot, 'sorbet/dist/filesystem-worker.js');
const providerControl = join(outputRoot, 'sorbet/dist/provider-control.js');
const packageBoundary = join(outputRoot, 'sorbet/package.json');
const vendorRoot = join(outputRoot, 'vendor');

assert(existsSync(entry), 'missing bundled Sorbet ACP entry');
assert(existsSync(worker), 'missing bundled Sorbet filesystem worker');
assert(existsSync(providerControl), 'missing bundled Sorbet Provider Center control entry');
assert(existsSync(packageBoundary), 'missing bundled Sorbet ESM package boundary');
for (const relativePath of [
  'seccomp/x64/apply-seccomp',
  'seccomp/arm64/apply-seccomp',
  'srt-win/x64/srt-win.exe',
  'srt-win/arm64/srt-win.exe',
]) {
  assert(existsSync(join(vendorRoot, relativePath)), `missing sandbox helper ${relativePath}`);
}

const version = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8' });
assert(version.status === 0, `bundled Sorbet --version failed: ${version.stderr}`);
assert(version.stdout.trim() === '0.0.0', 'bundled Sorbet reported an unexpected version');

const runSandboxLifecycle =
  process.platform === 'darwin' || process.env.LODY_SORBET_SANDBOX_SMOKE === '1';
if (runSandboxLifecycle) {
  await checkProviderCenterControl();
  await checkAcpLifecycle();
  console.log('Bundled Sorbet ACP lifecycle smoke passed.');
} else {
  await checkProviderCenterControl();
  console.log(
    'Bundled Sorbet package smoke passed; set LODY_SORBET_SANDBOX_SMOKE=1 on a prepared host to exercise ACP lifecycle.'
  );
}

async function checkProviderCenterControl() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'lody-sorbet-provider-center-smoke-'));
  try {
    const invoke = (request) => {
      const result = spawnSync(process.execPath, [providerControl], {
        cwd: dataRoot,
        env: { ...process.env, LODY_DATA_DIR: dataRoot },
        input: JSON.stringify(request),
        encoding: 'utf8',
      });
      assert(result.status === 0, `bundled Sorbet Provider Center failed: ${result.stderr}`);
      return { encoded: result.stdout, value: JSON.parse(result.stdout) };
    };
    const response = invoke({ action: 'snapshot' }).value;
    assert(response.snapshot?.version === 1, 'Provider Center returned an unexpected version');
    assert(
      response.snapshot?.claudeOAuthEnabled === false,
      'Claude OAuth must default to disabled'
    );
    assert(
      response.snapshot?.providers?.some((provider) => provider.id === 'openai-codex'),
      'Provider Center is missing Codex OAuth'
    );
    assert(
      response.snapshot?.providers?.some(
        (provider) => provider.id === 'anthropic' && provider.enabled === false
      ),
      'Provider Center did not keep Claude OAuth disabled'
    );
    const created = invoke({
      action: 'create-custom',
      provider: {
        name: 'Package smoke Provider',
        protocol: 'openai-responses',
        baseUrl: 'https://example.invalid/v1',
        models: [{ id: 'package-smoke-model' }],
      },
    }).value;
    const providerId = created.affectedProviderId;
    assert(typeof providerId === 'string' && providerId.length > 0, 'custom Provider id missing');
    const secret = 'package-smoke-api-key';
    const credential = invoke({ action: 'set-api-key', providerId, apiKey: secret });
    assert(!credential.encoded.includes(secret), 'Provider Center echoed an API key');
    const selected = invoke({ action: 'set-default', providerId }).value;
    assert(selected.snapshot?.defaultProviderId === providerId, 'custom Provider was not selected');
    assert(
      selected.snapshot?.defaultModelSelector?.endsWith('/package-smoke-model'),
      'custom Provider model was not selected'
    );
    invoke({ action: 'logout', providerId });
    const deleted = invoke({ action: 'delete-custom', providerId }).value;
    assert(
      !deleted.snapshot?.providers?.some((provider) => provider.id === providerId),
      'custom Provider was not deleted'
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function checkAcpLifecycle() {
  const home = await mkdtemp(join(tmpdir(), 'lody-sorbet-package-smoke-'));
  const dataDirectory = join(home, 'sorbet-data');
  let codexOAuthLoginPromptObserved = false;
  let codexOAuthCredentialPromptObserved = false;
  const child = spawn(process.execPath, [entry], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      SORBET_DATA_DIR: dataDirectory,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8_192);
  });

  try {
    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        unstable_createElicitation: async (params) => {
          if (params.mode === 'form') {
            const value = params.requestedSchema.properties.value;
            if (Array.isArray(value.oneOf)) {
              codexOAuthLoginPromptObserved = true;
              return { action: 'accept', content: { value: 'browser' } };
            }
            if (value._meta?.lody?.elicitation?.secret === true) {
              codexOAuthCredentialPromptObserved = true;
            }
            return { action: 'cancel' };
          }
          return { action: 'accept' };
        },
        unstable_completeElicitation: async () => {},
      }),
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
    );
    const initialized = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        auth: {
          terminal: false,
          _meta: { lody: { credentialForm: { version: 1 } } },
        },
        elicitation: { form: {}, url: {} },
      },
      clientInfo: { name: 'lody-package-smoke', title: 'Lody package smoke', version: '1' },
    });
    assert(initialized.agentInfo?.name === 'sorbet-acp', 'unexpected ACP implementation');
    assert(initialized.agentCapabilities?.providers != null, 'missing Provider capability');

    const authMethodIds = new Set((initialized.authMethods ?? []).map((method) => method.id));
    assert(authMethodIds.has('sorbet:openai-codex:oauth'), 'missing Codex OAuth method');
    assert(authMethodIds.has('sorbet:anthropic:oauth'), 'missing Anthropic OAuth method');

    const providerResponse = await connection.unstable_listProviders({});
    const providerIds = new Set(providerResponse.providers.map((provider) => provider.providerId));
    assert(providerIds.has('openai-codex'), 'missing openai-codex Provider');
    assert(providerIds.has('anthropic'), 'missing anthropic Provider');

    let authenticationError;
    try {
      await connection.authenticate({ methodId: 'sorbet:openai-codex:oauth' });
    } catch (error) {
      authenticationError = error;
    }
    assert(
      codexOAuthLoginPromptObserved,
      `bundled Codex OAuth implementation did not reach its login prompt: ${
        authenticationError instanceof Error
          ? authenticationError.message
          : String(authenticationError)
      }`
    );
    assert(
      codexOAuthCredentialPromptObserved,
      `bundled Codex OAuth implementation did not expose its credential-safe manual-code prompt: ${
        authenticationError instanceof Error
          ? authenticationError.message
          : String(authenticationError)
      }`
    );

    let sessionError;
    try {
      await connection.newSession({ cwd: home, mcpServers: [] });
    } catch (error) {
      sessionError = error;
    }
    assert(
      typeof sessionError === 'object' && sessionError !== null && sessionError.code === -32_000,
      'empty credential store did not return ACP auth_required'
    );
    assert(
      sessionError instanceof Error && /authentication required/iu.test(sessionError.message),
      'empty credential store returned an unexpected error'
    );

    await writeFile(
      join(dataDirectory, 'credentials.json'),
      `${JSON.stringify({ openai: { type: 'api_key', key: 'package-smoke-only' } })}\n`,
      { mode: 0o600 }
    );
    const session = await connection.newSession({ cwd: home, mcpServers: [] });
    const configOptionIds = new Set((session.configOptions ?? []).map((option) => option.id));
    assert(configOptionIds.has('model'), 'session is missing dynamic model configuration');
    assert(
      configOptionIds.has('permission_mode'),
      'session is missing dynamic permission configuration'
    );
    await checkCrossProcessFork(entry, home, dataDirectory, session.sessionId);
    await connection.closeSession({ sessionId: session.sessionId });
  } catch (error) {
    throw new Error(`Bundled Sorbet ACP smoke failed. stderr: ${stderr}`, { cause: error });
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
    ]);
    await rm(home, { recursive: true, force: true });
  }
}

async function checkCrossProcessFork(entry, cwd, dataDirectory, sourceSessionId) {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, HOME: cwd, SORBET_DATA_DIR: dataDirectory },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8_192);
  });
  try {
    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        unstable_createElicitation: async () => ({ action: 'cancel' }),
        unstable_completeElicitation: async () => {},
      }),
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
    );
    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'lody-package-fork-smoke', version: '1' },
    });
    const fork = await connection.unstable_forkSession({
      sessionId: sourceSessionId,
      cwd,
      mcpServers: [],
    });
    assert(fork.sessionId !== sourceSessionId, 'cross-process fork reused its source identity');
    await connection.closeSession({ sessionId: fork.sessionId });
  } catch (error) {
    throw new Error(`Bundled Sorbet cross-process fork failed. stderr: ${stderr}`, {
      cause: error,
    });
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
    ]);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
