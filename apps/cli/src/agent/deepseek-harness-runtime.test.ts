import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEEPSEEK_HARNESS_HOME_ENV,
  DEEPSEEK_HARNESS_VERSION,
  DeepSeekHarnessMixedSessionCompressionError,
  resolveDeepSeekHarnessHome,
  resolveDeepSeekHarnessProcessLaunch,
  resolveDeepSeekHarnessSpawn,
  resolveDeepSeekHarnessSessionCompression,
} from './deepseek-harness-runtime';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createSessionArtifact(
  sessionsRoot: string,
  filename: 'session.jsonl' | 'session.jsonl.zstd',
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
    throw new Error('DeepSeek Harness launch did not include bundled Node arguments');
  }
  const runtimeArgs: unknown = JSON.parse(Buffer.from(encodedRuntimeArgs, 'base64').toString());
  if (!Array.isArray(runtimeArgs) || !runtimeArgs.every((arg) => typeof arg === 'string')) {
    throw new Error('DeepSeek Harness bundled Node arguments are invalid');
  }
  const profileFlagIndex = runtimeArgs.indexOf('--profile');
  const profileName = runtimeArgs.at(profileFlagIndex + 1);
  if (profileFlagIndex < 0 || typeof profileName !== 'string') {
    throw new Error('DeepSeek Harness launch did not include a profile name');
  }
  const profileDir = join(rootDir, 'profiles', profileName);
  const [packageJson, cordisYml, cordisPatchYml, pnpmWorkspaceYaml] = await Promise.all([
    readFile(join(profileDir, 'package.json'), 'utf8'),
    readFile(join(profileDir, 'cordis.yml'), 'utf8'),
    readFile(join(profileDir, 'cordis.patch.yml'), 'utf8'),
    readFile(join(profileDir, 'pnpm-workspace.yaml'), 'utf8'),
  ]);
  return { profileName, profileDir, packageJson, cordisYml, cordisPatchYml, pnpmWorkspaceYaml };
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
    const entry = profile.cordisPatchYml.split('\n    - id: acp-agent\n')[1];
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
    expect(profile.cordisPatchYml).toContain(
      `path: ${JSON.stringify(join(adapterDir, 'deepseek-agent-presets'))}`
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

    expect(profile.profileName.startsWith('lody-acp-')).toBe(true);
    expect(profile.profileDir).toBe(join(rootDir, 'profiles', profile.profileName));
    expect(profile.cordisYml).toBe('[]\n');
    expect(profile.packageJson).toContain('"@deepseek-ai/dsh-base"');
    expect(profile.cordisPatchYml).toContain('compression: zstd');
    expect(launch.args).toContain('node');
    expect(launch.args).not.toContain('dsh');
    expect(launch.env.LODY_DSH_NODE_EXECUTABLE).toBe(process.execPath);
    expect(Buffer.from(launch.env.LODY_DSH_NODE_ARGS, 'base64').toString()).toContain(
      profile.profileName
    );
    expect(launch.args).not.toContain('dsh-acp-demo');
    expect(launch.args).not.toContain('--force');
    expect(launch.args).not.toContain('--legacy-peer-deps');
    expect(launch.args).not.toContain('@deepseek-ai/dsh@0.1.0-rc.6');
    // The Cordis ecosystem versions independently of the Harness family, and
    // a `DEEPSEEK_HARNESS_VERSION` specifier for it fails the cold install.
    expect(launch.args).toContain('@deepseek-ai/cordis@4.0.2');
    expect(launch.args).toContain('@deepseek-ai/cordis-plugin-hmr@1.0.17');
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
export async function runCli() {
  await writeFile(process.env.DSH_BOOTSTRAP_OUTPUT, JSON.stringify({
    execPath: process.execPath,
    argv: process.argv,
    importedAsMain: import.meta.main === true,
  }));
}
`.trim()
      );

      const launch = await resolveDeepSeekHarnessProcessLaunch({
        adapterPath: '/bundled/deepseek-acp.js',
        rootDir,
        extraArgs: ['--synthetic-flag'],
      });
      const launcherIndex = launch.args.indexOf('node');
      expect(launcherIndex).toBeGreaterThan(0);
      const launcher = launch.args.at(launcherIndex + 2);
      if (!launcher) throw new Error('DeepSeek Harness Node launcher was missing');
      let executable = { command: process.execPath, args: ['-e', launcher] };
      const forwardedPath = join(rootDir, 'npx-arguments.json');
      if (platform === 'windows') {
        const npmDir = join(rootDir, 'Node with spaces', 'node_modules', 'npm', 'bin');
        const nodeDir = join(rootDir, 'Node with spaces');
        await mkdir(npmDir, { recursive: true });
        await writeFile(join(nodeDir, 'npx.cmd'), '@exit /b 99\r\n');
        await writeFile(
          join(npmDir, 'npx-cli.js'),
          `
const { writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
writeFileSync(process.env.NPX_ARGUMENTS_OUTPUT, JSON.stringify({ args, cache: process.env.npm_config_cache }));
const child = spawnSync(process.execPath, args.slice(args.indexOf('node') + 1), { env: process.env, stdio: 'inherit' });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
`
        );
        // Exercise the real, complete package closure, not a shortened argument fixture.
        expect(launch.args.join(' ').length).toBeGreaterThan(8191);
        executable = resolveDeepSeekHarnessSpawn({
          ...launch,
          env: { ...launch.env, Path: nodeDir },
          workdir: rootDir,
          platform: 'win32',
        });
      }
      await promisify(execFile)(executable.command, executable.args, {
        env: {
          ...process.env,
          ...launch.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
          DSH_BOOTSTRAP_OUTPUT: outputPath,
          NPX_ARGUMENTS_OUTPUT: forwardedPath,
          npm_config_cache: join(rootDir, 'owned-cache'),
        },
      });

      if (platform === 'windows') {
        expect(JSON.parse(await readFile(forwardedPath, 'utf8'))).toEqual({
          args: launch.args,
          cache: join(rootDir, 'owned-cache'),
        });
      }

      const result: unknown = JSON.parse(await readFile(outputPath, 'utf8'));
      expect(result).toEqual({
        execPath: process.execPath,
        argv: [
          process.execPath,
          join(packageRoot, 'lib', 'bin.js'),
          '--profile',
          expect.stringMatching(/^lody-acp-/),
          '--synthetic-flag',
        ],
        importedAsMain: false,
      });
    }
  );

  it('uses zstd when an existing standalone Harness root is compressed', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lody-dsh-home-'));
    temporaryRoots.push(rootDir);
    const sessionsRoot = join(rootDir, 'sessions');
    const artifact = await createSessionArtifact(sessionsRoot, 'session.jsonl.zstd', 'zstd-bytes');

    expect(await resolveDeepSeekHarnessSessionCompression(sessionsRoot)).toBe('zstd');
    const launch = await resolveDeepSeekHarnessProcessLaunch({
      adapterPath: '/bundled/deepseek-acp.js',
      rootDir,
    });
    const profile = await readGeneratedProfile(launch, rootDir);

    expect(profile.cordisPatchYml).toContain('compression: zstd');
    expect(await readFile(artifact, 'utf8')).toBe('zstd-bytes');
  });

  it('keeps none for an existing legacy raw-only Lody root', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lody-dsh-home-'));
    temporaryRoots.push(rootDir);
    const sessionsRoot = join(rootDir, 'sessions');
    const artifact = await createSessionArtifact(sessionsRoot, 'session.jsonl', 'raw-jsonl');

    expect(await resolveDeepSeekHarnessSessionCompression(sessionsRoot)).toBe('none');
    const launch = await resolveDeepSeekHarnessProcessLaunch({
      adapterPath: '/bundled/deepseek-acp.js',
      rootDir,
    });
    const profile = await readGeneratedProfile(launch, rootDir);

    expect(profile.cordisPatchYml).toContain('compression: none');
    expect(await readFile(artifact, 'utf8')).toBe('raw-jsonl');
  });

  it('rejects mixed roots before publishing a profile and leaves both artifacts unchanged', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lody-dsh-home-'));
    temporaryRoots.push(rootDir);
    const sessionsRoot = join(rootDir, 'sessions');
    const rawArtifact = await createSessionArtifact(
      sessionsRoot,
      'session.jsonl',
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
  });
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
