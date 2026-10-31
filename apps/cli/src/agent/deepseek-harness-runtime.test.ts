import { getDeepSeekHarnessProviderConfigPath } from '@lody/shared';
import {
  createDeepSeekHarnessProfileFiles,
  DEEPSEEK_HARNESS_CORDIS_PACKAGE_VERSIONS,
} from 'acp-extension-dsh/profile';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEEPSEEK_HARNESS_HOME_ENV,
  DEEPSEEK_HARNESS_VERSION,
  DeepSeekHarnessMixedSessionCompressionError,
  resolveDeepSeekHarnessHome,
  resolveDeepSeekHarnessProcessLaunch,
  resolveDeepSeekHarnessSpawn,
  resolveDeepSeekHarnessSessionCompression,
  withDeepSeekModelCatalog,
} from './deepseek-harness-runtime';

import { Effect } from 'effect';
import { FakeProcessTable } from '@lody/shared/node/process-testing';
import type { ChildProcess } from 'node:child_process';
import { processLayer, runPromiseSquashedLegacy } from '@lody/shared/node/process';
import { prepareDeepSeekNodeEnvironment, resolveDeepSeekNodePath } from './deepseek-system-node';

const prepareNode = (env: NodeJS.ProcessEnv) =>
  runPromiseSquashedLegacy(
    prepareDeepSeekNodeEnvironment(env).pipe(Effect.provide(processLayer({})))
  );

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createSessionArtifact(
  sessionsRoot: string,
  filename: string,
  content: string,
  sessionId = 'session-1'
): Promise<string> {
  const sessionDir = join(sessionsRoot, '--synthetic-project--', sessionId);
  await mkdir(sessionDir, { recursive: true });
  const artifact = join(sessionDir, filename);
  await writeFile(artifact, content);
  return artifact;
}

async function readGeneratedProfile(
  launch: Awaited<ReturnType<typeof resolveDeepSeekHarnessProcessLaunch>>,
  rootDir: string
) {
  const encodedRuntimeArgs = launch.env.LODY_DSH_NODE_ARGS;
  if (!encodedRuntimeArgs) {
    throw new Error('DeepSeek Harness launch did not include Node bootstrap arguments');
  }
  const runtimeArgs: unknown = JSON.parse(Buffer.from(encodedRuntimeArgs, 'base64').toString());
  if (!Array.isArray(runtimeArgs) || !runtimeArgs.every((arg) => typeof arg === 'string')) {
    throw new Error('DeepSeek Harness Node bootstrap arguments are invalid');
  }
  const profileFlagIndex = runtimeArgs.indexOf('--profile');
  const profileName = runtimeArgs.at(profileFlagIndex + 1);
  if (profileFlagIndex < 0 || typeof profileName !== 'string') {
    throw new Error('DeepSeek Harness launch did not include a profile name');
  }
  const profileDir = join(rootDir, 'profiles', profileName);
  const [packageJson, cordisPatchYml, pnpmWorkspaceYaml] = await Promise.all([
    readFile(join(profileDir, 'package.json'), 'utf8'),
    readFile(join(profileDir, 'cordis.patch.yml'), 'utf8'),
    readFile(join(profileDir, 'pnpm-workspace.yaml'), 'utf8'),
  ]);
  const bundle = JSON.parse(packageJson).dsh.profile.bundles.find((name: string) =>
    name.startsWith('@lody/dsh-host-')
  );
  const generatedPatchYml = await readFile(
    join(profileDir, 'node_modules', bundle, 'cordis.patch.yml'),
    'utf8'
  );
  return {
    profileName,
    profileDir,
    packageJson,
    cordisPatchYml,
    generatedPatchYml,
    pnpmWorkspaceYaml,
  };
}

describe('resolveDeepSeekHarnessHome', () => {
  it('defaults to .dsh under the user home', () => {
    const homeDir = resolve('synthetic-user-home');

    expect(resolveDeepSeekHarnessHome({}, homeDir)).toBe(join(homeDir, '.dsh'));
    expect(resolveDeepSeekHarnessHome({ DSH_HOME: '   ' }, homeDir)).toBe(join(homeDir, '.dsh'));
  });

  it('honors DSH_HOME and expands a leading tilde', () => {
    const homeDir = resolve('synthetic-user-home');
    const configuredHome = resolve('custom-dsh-home');

    expect(resolveDeepSeekHarnessHome({ DSH_HOME: configuredHome }, homeDir)).toBe(configuredHome);
    expect(resolveDeepSeekHarnessHome({ DSH_HOME: '~/custom-dsh-home' }, homeDir)).toBe(
      join(homeDir, 'custom-dsh-home')
    );
  });
});

describe('resolveDeepSeekHarnessProcessLaunch', () => {
  it('isolates providers and preserves edited YAML/settings across concurrent launches and upgrades', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'lody-dsh-providers-'));
    temporaryRoots.push(dataRoot);
    const rootDir = join(dataRoot, 'legacy-dsh');
    const sessionsRoot = join(rootDir, 'sessions');
    const artifact = await createSessionArtifact(
      sessionsRoot,
      'session.jsonl',
      'synthetic history'
    );
    const options = { dataRoot, rootDir, adapterPath: '/app/v1/deepseek-acp.js' };
    const [first, second] = await Promise.all([
      resolveDeepSeekHarnessProcessLaunch({ ...options, providerId: 'provider-a' }),
      resolveDeepSeekHarnessProcessLaunch({ ...options, providerId: 'provider-b' }),
    ]);
    expect(first.env.DSH_HOME).not.toBe(second.env.DSH_HOME);
    expect(first.env.ACP_EXTENSION_DSH_SESSION_ROOT).toBe(sessionsRoot);
    expect(first.env.ACP_EXTENSION_DSH_LEGACY_HOME).toBe(rootDir);
    const configPath = getDeepSeekHarnessProviderConfigPath(dataRoot, 'provider-a');
    const edited = '- id: agent-default-model\n  config:\n    model: custom-model\n';
    await writeFile(configPath, edited);
    const profileDir = join(first.env.DSH_HOME, 'profiles', 'lody-acp');
    const manifestPath = join(profileDir, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.dependencies = { 'synthetic-plugin': '1.2.3' };
    manifest.dsh.profile.bundles.push('synthetic-plugin');
    manifest.dsh.profile.customOption = 'preserved';
    manifest.pnpm = { overrides: { 'synthetic-dependency': '1.0.0' } };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(profileDir, 'pnpm-lock.yaml'), 'synthetic-lockfile');
    await writeFile(
      join(profileDir, 'pnpm-workspace.yaml'),
      'allowBuilds:\n  synthetic-plugin: true\n'
    );
    const settingsPath = join(first.env.DSH_HOME, 'settings.yaml');
    await writeFile(settingsPath, 'synthetic-setting: preserved\n');
    const [upgrade] = await Promise.all([
      resolveDeepSeekHarnessProcessLaunch({
        ...options,
        providerId: 'provider-a',
        adapterPath: '/app/v2/deepseek-acp.js',
      }),
      resolveDeepSeekHarnessProcessLaunch({
        ...options,
        providerId: 'provider-a',
        adapterPath: '/app/v2/deepseek-acp.js',
      }),
    ]);
    expect(upgrade.env.DSH_HOME).toBe(first.env.DSH_HOME);
    const profile = await readGeneratedProfile(upgrade, first.env.DSH_HOME);
    expect(profile.generatedPatchYml).toContain('file:///app/v2/deepseek-acp.js');
    expect(profile.generatedPatchYml).toContain('compression: none');
    const upgradedManifest = JSON.parse(profile.packageJson);
    expect(upgradedManifest.dependencies).toEqual(manifest.dependencies);
    expect(upgradedManifest.pnpm).toEqual(manifest.pnpm);
    expect(upgradedManifest.dsh.profile.customOption).toBe('preserved');
    expect(upgradedManifest.dsh.profile.bundles.at(-1)).toBe('synthetic-plugin');
    expect(
      upgradedManifest.dsh.profile.bundles.filter((name: string) =>
        name.startsWith('@lody/dsh-host-')
      )
    ).toHaveLength(1);
    expect(await readFile(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe('synthetic-lockfile');
    expect(profile.pnpmWorkspaceYaml).toBe('allowBuilds:\n  synthetic-plugin: true\n');
    expect(await readFile(configPath, 'utf8')).toBe(edited);
    expect(await readFile(settingsPath, 'utf8')).toBe('synthetic-setting: preserved\n');
    expect(
      await readFile(getDeepSeekHarnessProviderConfigPath(dataRoot, 'provider-b'), 'utf8')
    ).toBe('[]\n');
    expect(await readFile(artifact, 'utf8')).toBe('synthetic history');
    expect(upgrade.env.ACP_EXTENSION_DSH_QUERY_PATH).toBe(join(sessionsRoot, 'session-query.db'));
  });

  it('leaves a malformed user manifest unchanged and reports the failure', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lody-dsh-invalid-'));
    temporaryRoots.push(rootDir);
    await resolveDeepSeekHarnessProcessLaunch({ rootDir, adapterPath: '/synthetic/acp.js' });
    const manifest = join(rootDir, 'profiles', 'lody-acp', 'package.json');
    await writeFile(manifest, '{broken');
    await expect(
      resolveDeepSeekHarnessProcessLaunch({ rootDir, adapterPath: '/synthetic/v2/acp.js' })
    ).rejects.toThrow();
    expect(await readFile(manifest, 'utf8')).toBe('{broken');
  });

  it('publishes the adapter path and the preset root into a dsh profile', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lody-dsh-home-'));
    temporaryRoots.push(rootDir);
    const adapterDir = join(rootDir, '应用 #100%');
    await mkdir(adapterDir);
    const adapterPath = join(adapterDir, 'deepseek-acp.mjs');
    await writeFile(adapterPath, 'export const marker = "synthetic-acp-loaded";');

    const launch = await resolveDeepSeekHarnessProcessLaunch({ adapterPath, rootDir });
    const profile = await readGeneratedProfile(launch, rootDir);
    // Read the generated YAML's JSON-quoted scalar without evaluating its !!js tags.
    const entry = profile.generatedPatchYml.split('\n    - id: acp-agent\n')[1];
    const name = entry?.split('\n').find((line) => line.startsWith('      name: '));
    if (!name) throw new Error('Generated profile has no ACP adapter entry');
    const specifier: unknown = JSON.parse(name.slice('      name: '.length));
    if (typeof specifier !== 'string') throw new Error('ACP adapter entry is not a string');
    // Cordis resolves `name` as a module specifier, so the generator renders a
    // `file:` URL. A raw Windows drive path would parse as the `c:` scheme.
    expect(specifier.startsWith('file:')).toBe(true);
    expect(resolve(fileURLToPath(specifier))).toBe(resolve(adapterPath));

    // A separate Node process exercises its native ESM loader, not Vite's import transform.
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--input-type=module',
      '-e',
      'const adapter = await import(process.argv[1]); console.log(adapter.marker);',
      specifier,
    ]);
    expect(stdout.trim()).toBe('synthetic-acp-loaded');
    expect(profile.generatedPatchYml).toContain(
      `presetRoot: ${JSON.stringify(join(adapterDir, 'deepseek-agent-presets'))}`
    );

    const repeated = await readGeneratedProfile(
      await resolveDeepSeekHarnessProcessLaunch({ adapterPath, rootDir }),
      rootDir
    );
    expect(repeated).toEqual(profile);
  });

  it('publishes and loads the generated ACP profile from the resolved Harness home', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lody-dsh-home-'));
    temporaryRoots.push(rootDir);

    const launch = await resolveDeepSeekHarnessProcessLaunch({
      adapterPath: '/bundled/deepseek-acp.js',
      rootDir,
    });
    const profile = await readGeneratedProfile(launch, rootDir);

    expect(profile.profileName).toBe('lody-acp');
    expect(profile.cordisPatchYml).toBe('[]\n');
    expect(profile.profileDir).toBe(join(rootDir, 'profiles', profile.profileName));
    expect(profile.packageJson).toContain('"@deepseek-ai/dsh-base"');
    expect(profile.generatedPatchYml).toContain('compression: zstd');
    expect(launch.args).toContain('node');
    expect(launch.args).not.toContain('dsh');
    expect('LODY_DSH_NODE_EXECUTABLE' in launch.env).toBe(false);
    expect(Buffer.from(launch.env.LODY_DSH_NODE_ARGS, 'base64').toString()).toContain(
      profile.profileName
    );
    expect(launch.args).not.toContain('dsh-acp-demo');
    expect(launch.args).not.toContain('--force');
    expect(launch.args).not.toContain('--legacy-peer-deps');
    expect(launch.args).not.toContain('@deepseek-ai/dsh@0.1.0-rc.6');
    // The Cordis ecosystem versions independently of the Harness family, and
    // a `DEEPSEEK_HARNESS_VERSION` specifier for it fails the cold install.
    expect(launch.args).toContain(
      `@deepseek-ai/cordis@${DEEPSEEK_HARNESS_CORDIS_PACKAGE_VERSIONS['@deepseek-ai/cordis']}`
    );
    expect(launch.args).toContain(`@deepseek-ai/dsh-hmr@${DEEPSEEK_HARNESS_VERSION}`);
    expect(launch.args).not.toContain(`@deepseek-ai/cordis@${DEEPSEEK_HARNESS_VERSION}`);
    expect(launch.env[DEEPSEEK_HARNESS_HOME_ENV]).toBe(rootDir);
    expect(await readdir(rootDir)).toEqual(expect.arrayContaining(['profiles', 'sessions']));
  });

  it.each(['posix', 'windows'] as const)(
    'executes the pinned dsh entry through the %s launch path',
    async (platform) => {
      const rootDir = await mkdtemp(join(tmpdir(), 'lody-dsh-home-'));
      temporaryRoots.push(rootDir);
      const closureRoot = join(rootDir, 'synthetic-npx', 'node_modules');
      const binDir = join(closureRoot, '.bin');
      const packageRoot = join(closureRoot, '@deepseek-ai', 'dsh');
      const outputPath = join(rootDir, 'dsh-bootstrap-output.json');
      const nativeRoot = join(closureRoot, '@deepseek-ai', 'dsh-win32-process');
      const runnerRoot = join(closureRoot, '@deepseek-ai', 'dsh-subprocess-local');
      for (const root of [nativeRoot, runnerRoot]) {
        await mkdir(join(root, 'lib'), { recursive: true });
        await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
      }
      // Synthetic native boundary: retain all arguments so the test verifies
      // that adding the no-window flag preserves Job launch and stdio inputs.
      await writeFile(
        join(nativeRoot, 'lib', 'index.js'),
        `
const api = {
  createProcessW: (...args) => args,
  createProcessAsUserW: (...args) => args,
};
export const loadWin32ProcessBindings = () => api;
export const probe = () => [
  api.createProcessW('exe', 'argv', null, null, 1, 1028, 'env', 'cwd', 'stdio', 'result'),
  api.createProcessAsUserW('token', 'exe', 'argv', null, null, 1, 1028, 'env', 'cwd', 'stdio', 'result'),
];
`
      );
      await writeFile(
        join(runnerRoot, 'lib', 'runner.js'),
        `
import { probe } from '../../dsh-win32-process/lib/index.js';
process.stdout.write(JSON.stringify({ native: probe(), argv: process.argv.slice(2) }));
`
      );
      await mkdir(join(packageRoot, 'lib'), { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFile(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: '@deepseek-ai/dsh',
          version: DEEPSEEK_HARNESS_VERSION,
          type: 'module',
        })
      );
      await writeFile(
        join(packageRoot, 'lib', 'bin.js'),
        `
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probe } from '../../dsh-win32-process/lib/index.js';
export async function runCli() {
  const native = probe();
  const runner = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../dsh-subprocess-local/lib/runner.js', import.meta.url)), '--', 'synthetic command']);
  const outputs = [];
  for (let index = 0; index < 3; index++) {
    const result = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'synthetic output ' + index]);
    outputs.push(result.stdout);
  }
  const failure = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.stderr.write("synthetic failure"); process.exitCode = 23'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
  });
  await writeFile(process.env.DSH_BOOTSTRAP_OUTPUT, JSON.stringify({
    execPath: process.execPath,
    argv: process.argv,
    importedAsMain: import.meta.main === true,
    outputs,
    failure,
    native,
    runner: JSON.parse(runner.stdout),
  }));
}
`.trim()
      );

      const launch = await resolveDeepSeekHarnessProcessLaunch({
        adapterPath: '/bundled/deepseek-acp.js',
        rootDir,
        extraArgs: ['--synthetic-flag'],
      });
      const nodeEnv = await prepareNode({ ...process.env, ...launch.env });
      const launcherIndex = launch.args.indexOf('node');
      expect(launcherIndex).toBeGreaterThan(0);
      const launcher = launch.args.at(launcherIndex + 2);
      if (!launcher) throw new Error('DeepSeek Harness Node launcher was missing');
      let executable = { command: process.execPath, args: ['-e', launcher] };
      const forwardedPath = join(rootDir, 'npx-arguments.json');
      const spawnTracePath = join(rootDir, 'spawn-trace.jsonl');
      const observerPath = join(rootDir, 'observe-spawn.cjs');
      // Observe the real normalized child-process boundary before the generated
      // policy loads. Simulate Windows policy on POSIX, then restore the actual
      // platform before executing native processes. Every child loads its own copy.
      await writeFile(
        observerPath,
        `
const { ChildProcess } = require('node:child_process');
const { appendFileSync } = require('node:fs');
require('node:path');
const platform = process.platform;
Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform === 'windows' ? 'win32' : 'linux')}, configurable: true });
const spawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function(options) {
  appendFileSync(process.env.SPAWN_TRACE_PATH, JSON.stringify({ windowsHide: options.windowsHide }) + '\\n');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return spawn.call(this, options);
};
`
      );
      if (platform === 'windows') {
        const npmDir = join(rootDir, 'Node with spaces', 'node_modules', 'npm', 'bin');
        const nodeDir = join(rootDir, 'Node with spaces');
        await mkdir(npmDir, { recursive: true });
        await writeFile(join(nodeDir, 'npx.cmd'), '@exit /b 99\r\n');
        await writeFile(
          join(npmDir, 'npx-cli.js'),
          `
const { writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
writeFileSync(process.env.NPX_ARGUMENTS_OUTPUT, JSON.stringify({ args, cache: process.env.npm_config_cache }));
const child = spawn(process.execPath, args.slice(args.indexOf('node') + 1), { env: process.env, stdio: 'inherit' });
child.on('error', error => { throw error; });
child.on('exit', code => { process.exitCode = code ?? 1; });
`
        );
        // Exercise the real, complete package closure, not a shortened argument fixture.
        expect(launch.args.join(' ').length).toBeGreaterThan(8191);
        executable = resolveDeepSeekHarnessSpawn({
          ...launch,
          env: { LODY_DSH_NODE_EXECUTABLE: nodeEnv.LODY_DSH_NODE_EXECUTABLE, Path: nodeDir },
          workdir: rootDir,
          platform: 'win32',
        });
      }
      await promisify(execFile)(executable.command, executable.args, {
        env: {
          ...process.env,
          ...nodeEnv,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
          DSH_BOOTSTRAP_OUTPUT: outputPath,
          NPX_ARGUMENTS_OUTPUT: forwardedPath,
          SPAWN_TRACE_PATH: spawnTracePath,
          NODE_OPTIONS: `--require ${JSON.stringify(observerPath)}`,
          npm_config_cache: join(rootDir, 'owned-cache'),
        },
      });

      if (platform === 'windows') {
        expect(JSON.parse(await readFile(forwardedPath, 'utf8'))).toEqual({
          args: launch.args,
          cache: join(rootDir, 'owned-cache'),
        });
      }
      const spawnTrace = (await readFile(spawnTracePath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      // npm (Windows path only), forwarder, then five DSH subprocesses. All
      // Windows boundaries stay hidden; POSIX DSH retains Node's default.
      expect(spawnTrace).toEqual(
        platform === 'windows'
          ? Array.from({ length: 7 }, () => ({ windowsHide: true }))
          : [{ windowsHide: true }, ...Array.from({ length: 5 }, () => ({ windowsHide: false }))]
      );

      const result: unknown = JSON.parse(await readFile(outputPath, 'utf8'));
      const flags = platform === 'windows' ? 1028 | 0x08000000 : 1028;
      const native = [
        ['exe', 'argv', null, null, 1, flags, 'env', 'cwd', 'stdio', 'result'],
        ['token', 'exe', 'argv', null, null, 1, flags, 'env', 'cwd', 'stdio', 'result'],
      ];
      expect(result).toEqual({
        execPath: process.execPath,
        argv: [
          process.execPath,
          join(packageRoot, 'lib', 'bin.js'),
          '--profile',
          'lody-acp',
          '--patch',
          expect.stringContaining('/host.patch.yml'),
          '--synthetic-flag',
        ],
        importedAsMain: false,
        outputs: ['synthetic output 0', 'synthetic output 1', 'synthetic output 2'],
        failure: { code: 23, stderr: 'synthetic failure' },
        native,
        runner: { native, argv: ['--', 'synthetic command'] },
      });
    }
  );

  it.each(['session.jsonl.zstd', 'session.v4.jsonl.zstd'])(
    'uses zstd for compressed %s',
    async (filename) => {
      const rootDir = await mkdtemp(join(tmpdir(), 'lody-dsh-home-'));
      temporaryRoots.push(rootDir);
      const sessionsRoot = join(rootDir, 'sessions');
      const artifact = await createSessionArtifact(sessionsRoot, filename, 'zstd-bytes');

      expect(await resolveDeepSeekHarnessSessionCompression(sessionsRoot)).toBe('zstd');
      const launch = await resolveDeepSeekHarnessProcessLaunch({
        adapterPath: '/bundled/deepseek-acp.js',
        rootDir,
      });
      const profile = await readGeneratedProfile(launch, rootDir);

      expect(profile.generatedPatchYml).toContain('compression: zstd');
      expect(await readFile(artifact, 'utf8')).toBe('zstd-bytes');
    }
  );

  it.each(['session.jsonl', 'session.v4.jsonl'])('keeps none for raw %s', async (filename) => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lody-dsh-home-'));
    temporaryRoots.push(rootDir);
    const sessionsRoot = join(rootDir, 'sessions');
    const artifact = await createSessionArtifact(sessionsRoot, filename, 'raw-jsonl');

    expect(await resolveDeepSeekHarnessSessionCompression(sessionsRoot)).toBe('none');
    const launch = await resolveDeepSeekHarnessProcessLaunch({
      adapterPath: '/bundled/deepseek-acp.js',
      rootDir,
    });
    const profile = await readGeneratedProfile(launch, rootDir);

    expect(profile.generatedPatchYml).toContain('compression: none');
    expect(await readFile(artifact, 'utf8')).toBe('raw-jsonl');
  });

  it.each(['session.jsonl', 'session.v4.jsonl'])(
    'rejects mixed roots with %s without modifying artifacts',
    async (filename) => {
      const rootDir = await mkdtemp(join(tmpdir(), 'lody-dsh-home-'));
      temporaryRoots.push(rootDir);
      const sessionsRoot = join(rootDir, 'sessions');
      const rawArtifact = await createSessionArtifact(
        sessionsRoot,
        filename,
        'raw-jsonl',
        'raw-session'
      );
      const zstdArtifact = await createSessionArtifact(
        sessionsRoot,
        'session.jsonl.zstd',
        'zstd-bytes',
        'zstd-session'
      );

      await expect(
        resolveDeepSeekHarnessProcessLaunch({
          adapterPath: '/bundled/deepseek-acp.js',
          rootDir,
        })
      ).rejects.toMatchObject({
        name: 'DeepSeekHarnessMixedSessionCompressionError',
        code: 'DSH_MIXED_SESSION_COMPRESSION',
        sessionsRoot,
        rawArtifact,
        zstdArtifact,
      } satisfies Partial<DeepSeekHarnessMixedSessionCompressionError>);

      expect(await readdir(rootDir)).toEqual(['sessions']);
      expect(await readFile(rawArtifact, 'utf8')).toBe('raw-jsonl');
      expect(await readFile(zstdArtifact, 'utf8')).toBe('zstd-bytes');
    }
  );
});

describe('resolveDeepSeekHarnessSpawn', () => {
  it('preserves npx failures and never falls through to another npm installation', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lody-dsh-npx-'));
    temporaryRoots.push(rootDir);
    const npmBin = join(rootDir, 'node_modules', 'npm', 'bin');
    await mkdir(npmBin, { recursive: true });
    await writeFile(join(rootDir, 'npx.cmd'), '@exit /b 99\r\n');
    const entry = join(npmBin, 'npx-cli.js');
    await writeFile(entry, 'console.error("synthetic npm failure"); process.exitCode = 17;');
    const options = {
      command: 'npx',
      args: ['--prefer-online', '-y'],
      workdir: rootDir,
      env: { LODY_DSH_NODE_EXECUTABLE: process.execPath, Path: rootDir },
      platform: 'win32' as const,
    };
    const launch = resolveDeepSeekHarnessSpawn(options);
    await expect(promisify(execFile)(launch.command, launch.args)).rejects.toMatchObject({
      code: 17,
      stderr: expect.stringContaining('synthetic npm failure'),
    });
    await rm(entry);
    const otherNode = join(rootDir, 'another-node');
    const otherNpmBin = join(otherNode, 'node_modules', 'npm', 'bin');
    await mkdir(otherNpmBin, { recursive: true });
    await writeFile(join(otherNode, 'npx.cmd'), '@exit /b 99\r\n');
    await writeFile(join(otherNpmBin, 'npx-cli.js'), 'process.exitCode = 0;');
    options.env.Path = `${rootDir};${otherNode}`;
    expect(() => resolveDeepSeekHarnessSpawn(options)).toThrow('npx-cli.js is missing');
    await rm(join(rootDir, 'npx.cmd'));
    options.env.Path = rootDir;
    expect(() => resolveDeepSeekHarnessSpawn(options)).toThrow('npx was not found');
  });

  it('leaves non-Windows and non-DSH commands unchanged', () => {
    const options = { command: 'npx', args: ['-y', 'example'], env: {}, workdir: '/unused' };
    expect(resolveDeepSeekHarnessSpawn({ ...options, platform: 'win32' })).toEqual({
      command: options.command,
      args: options.args,
    });
    expect(
      resolveDeepSeekHarnessSpawn({
        ...options,
        env: { LODY_DSH_NODE_EXECUTABLE: process.execPath },
        platform: 'linux',
      })
    ).toEqual({ command: options.command, args: options.args });
  });
});

describe('DeepSeek system Node environment', () => {
  it('selects the first absolute PATH node, preserves provider env, and runs the selected executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lody-dsh-system-node-'));
    temporaryRoots.push(root);
    const first = join(root, 'Node with spaces');
    const second = join(root, 'another node');
    await mkdir(first);
    await mkdir(second);
    const filename = process.platform === 'win32' ? 'node.exe' : 'node';
    await symlink(process.execPath, join(first, filename));
    await symlink(process.execPath, join(second, filename));
    const env = {
      PATH: [first, second].join(delimiter),
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: root,
      SYNTHETIC_PROVIDER: 'preserved',
    };
    const prepared = await prepareNode(env);
    expect(prepared.LODY_DSH_NODE_EXECUTABLE).toBe(process.execPath);
    expect(prepared.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(prepared.SYNTHETIC_PROVIDER).toBe('preserved');
    expect(prepared.DSH_HOME).toBe(root);
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    const result = await promisify(execFile)(
      prepared.LODY_DSH_NODE_EXECUTABLE,
      ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron})'],
      { env: prepared }
    );
    expect(JSON.parse(result.stdout)).toEqual({ node: process.versions.node });
  });

  it('terminates an in-flight Node probe when its caller cancels', async () => {
    const table = new FakeProcessTable('linux');
    let announceSpawn: (child: ChildProcess) => void = () => {};
    const spawned = new Promise<ChildProcess>((onSpawned) => {
      announceSpawn = onSpawned;
    });
    const controller = new AbortController();
    const nodeProcess = {
      ...table.api,
      spawn: (...args: Parameters<typeof table.api.spawn>) => {
        const child = table.api.spawn(...args);
        announceSpawn(child);
        return child;
      },
    };
    const pending = runPromiseSquashedLegacy(
      prepareDeepSeekNodeEnvironment(process.env).pipe(
        Effect.provide(processLayer({ nodeProcess }))
      ),
      { signal: controller.signal }
    );
    const rejected = expect(pending).rejects.toBeDefined();
    const child = await spawned;
    expect(table.isAlive(child.pid ?? -1)).toBe(true);
    controller.abort();
    await rejected;
    expect(table.isAlive(child.pid ?? -1)).toBe(false);
  });

  it('uses case-insensitive Windows Path without looking in the workdir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lody-dsh-node-win-'));
    temporaryRoots.push(root);
    await writeFile(join(root, 'node.exe'), 'synthetic executable');
    expect(resolveDeepSeekNodePath({ Path: `;relative;"${root}"` }, 'win32')).toBe(
      join(root, 'node.exe')
    );
  });

  it('reports missing Node and succeeds on retry after installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lody-dsh-node-missing-'));
    temporaryRoots.push(root);
    const env = { PATH: root };
    await expect(prepareNode(env)).rejects.toThrow('[DSH_NODE_NOT_FOUND]');
    await symlink(process.execPath, join(root, process.platform === 'win32' ? 'node.exe' : 'node'));
    expect((await prepareNode(env)).LODY_DSH_NODE_EXECUTABLE).toBe(process.execPath);
  });

  it.skipIf(process.platform === 'win32')(
    'distinguishes an unexecutable Node from a missing installation',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'lody-dsh-node-permissions-'));
      temporaryRoots.push(root);
      await writeFile(join(root, 'node'), 'not executable', { mode: 0o600 });
      const second = join(root, 'second');
      await mkdir(second);
      await symlink(process.execPath, join(second, 'node'));
      await expect(prepareNode({ PATH: [root, second].join(delimiter) })).rejects.toThrow(
        '[DSH_NODE_EXEC_FAILED]'
      );
    }
  );

  it.skipIf(process.platform === 'win32').each([
    { node: '24.1.0', napi: '10' },
    { node: '24.22.1', napi: '9' },
    { node: '24.22.1', napi: '10', electron: '44.9.3' },
  ])('rejects unsupported runtime metadata %j', async (runtime) => {
    const root = await mkdtemp(join(tmpdir(), 'lody-dsh-node-version-'));
    temporaryRoots.push(root);
    await writeFile(
      join(root, 'node'),
      "#!/bin/sh\nprintf '%s\n' " +
        JSON.stringify(JSON.stringify({ execPath: process.execPath, ...runtime })) +
        '\n',
      { mode: 0o700 }
    );
    await expect(prepareNode({ PATH: root })).rejects.toThrow('[DSH_NODE_UNSUPPORTED]');
  });
});

describe('withDeepSeekModelCatalog', () => {
  const catalog = [
    { id: 'vision/model', name: 'Vision model', inputModalities: ['text', 'image'] as const },
    { id: 'plain/model', name: 'Plain model', inputModalities: ['text'] as const },
  ];
  const adapterProfile = () =>
    createDeepSeekHarnessProfileFiles({
      adapterPath: '/app/deepseek-acp.js',
      presetRoot: '/app/presets',
    });

  /** Evaluate the row the Harness evaluates, with the user's settings section stubbed. */
  function runLlmDeepSeekRow(
    patchYml: string,
    section?: Record<string, unknown>
  ): Record<string, unknown> {
    const row = patchYml.split('- id: llm-deepseek\n')[1]?.split('\n')[0];
    if (!row) throw new Error('the generated patch has no llm-deepseek row');
    const expression: unknown = JSON.parse(row.slice(row.indexOf('!!js ') + 5));
    if (typeof expression !== 'string') throw new Error('the row is not a JavaScript expression');
    return runInNewContext(expression, {
      baseUrl: 'file:///synthetic/profile/',
      process: {
        env: {},
        getBuiltinModule: (name: string) => {
          if (name === 'node:fs')
            return {
              readFileSync: () => {
                if (!section) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                return 'synthetic YAML';
              },
            };
          if (name === 'node:path') return { join: (...parts: string[]) => parts.join('/') };
          if (name === 'node:os') return { homedir: () => '/synthetic' };
          return { createRequire: () => () => ({ load: () => ({ 'llm-deepseek': section }) }) };
        },
      },
    }) as Record<string, unknown>;
  }

  it('leaves the adapter patch untouched without a catalog', () => {
    const files = adapterProfile();
    expect(withDeepSeekModelCatalog(files.cordisPatchYml, undefined)).toBe(files.cordisPatchYml);
    expect(withDeepSeekModelCatalog(files.cordisPatchYml, [])).toBe(files.cordisPatchYml);
  });

  it('declares the gateway catalog when the user declared none', () => {
    const patched = withDeepSeekModelCatalog(adapterProfile().cordisPatchYml, catalog);
    expect(runLlmDeepSeekRow(patched)).toEqual({ models: catalog });
  });

  it('keeps a user-declared catalog and every other settings field', () => {
    const section = {
      baseURL: 'https://gateway.example/v1',
      thinking: 'disabled',
      models: [{ id: 'user/model', inputModalities: ['text'] }],
    };
    const patched = withDeepSeekModelCatalog(adapterProfile().cordisPatchYml, catalog);
    expect(runLlmDeepSeekRow(patched, section)).toEqual(section);
  });

  it('degrades instead of failing the launch when a row is unrecognized', () => {
    const files = adapterProfile();
    const reformatted = files.cordisPatchYml.replace(
      /- id: llm-deepseek\n {2}config: !!js .*$/mu,
      '- id: llm-deepseek\n  config: {}\n'
    );
    expect(reformatted).not.toBe(files.cordisPatchYml);
    expect(withDeepSeekModelCatalog(reformatted, catalog)).toBe(reformatted);
  });

  it('writes the catalog into the content-addressed host layer', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'lody-dsh-catalog-'));
    temporaryRoots.push(dataRoot);
    const options = { dataRoot, adapterPath: '/app/deepseek-acp.js', providerId: 'provider-a' };
    // Sequential launches: the profile manifest keeps only the newest host layer.
    const native = await resolveDeepSeekHarnessProcessLaunch(options);
    const nativeProfile = await readGeneratedProfile(native, native.env.DSH_HOME);
    const gateway = await resolveDeepSeekHarnessProcessLaunch({
      ...options,
      modelCatalog: catalog,
    });
    const gatewayProfile = await readGeneratedProfile(gateway, gateway.env.DSH_HOME);
    const repeat = await resolveDeepSeekHarnessProcessLaunch({ ...options, modelCatalog: catalog });
    const repeatProfile = await readGeneratedProfile(repeat, repeat.env.DSH_HOME);
    expect(nativeProfile.generatedPatchYml).not.toContain('vision/model');
    expect(gatewayProfile.generatedPatchYml).not.toBe(nativeProfile.generatedPatchYml);
    // The same catalog is the same generated layer, so reruns reuse one bundle.
    expect(repeatProfile.generatedPatchYml).toBe(gatewayProfile.generatedPatchYml);
    expect(runLlmDeepSeekRow(gatewayProfile.generatedPatchYml)).toEqual({ models: catalog });
  });
});
