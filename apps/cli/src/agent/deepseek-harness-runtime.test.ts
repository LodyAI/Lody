import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEEPSEEK_HARNESS_HOME_ENV,
  DeepSeekHarnessMixedSessionCompressionError,
  resolveDeepSeekHarnessHome,
  resolveDeepSeekHarnessProcessLaunch,
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

async function readGeneratedConfig(
  launch: Awaited<ReturnType<typeof resolveDeepSeekHarnessProcessLaunch>>
) {
  const configFlagIndex = launch.args.indexOf('--config');
  const configPath = launch.args.at(configFlagIndex + 1);
  if (configFlagIndex < 0 || configPath === undefined) {
    throw new Error('DeepSeek Harness launch did not include a config path');
  }
  return { configPath, config: await readFile(configPath, 'utf8') };
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
  it('publishes an importable adapter URL while preserving the preset filesystem path', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lody-dsh-home-'));
    temporaryRoots.push(rootDir);
    const adapterDir = join(rootDir, '应用 #100%');
    await mkdir(adapterDir);
    const adapterPath = join(adapterDir, 'deepseek-acp.mjs');
    await writeFile(adapterPath, 'export const marker = "synthetic-acp-loaded";');

    const launch = await resolveDeepSeekHarnessProcessLaunch({ adapterPath, rootDir });
    const { config } = await readGeneratedConfig(launch);
    // Read the generated YAML's JSON-quoted scalar without evaluating its !!js tags.
    const entry = config.split('\n- id: acp-agent\n')[1];
    const name = entry?.split('\n').find((line) => line.startsWith('  name: '));
    if (!name) throw new Error('Generated config has no ACP adapter entry');
    const specifier: unknown = JSON.parse(name.slice('  name: '.length));
    if (typeof specifier !== 'string') throw new Error('ACP adapter entry is not a string');
    expect(new URL(specifier).protocol).toBe('file:');

    // A separate Node process exercises its native ESM loader, not Vite's import transform.
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--input-type=module',
      '-e',
      'const adapter = await import(process.argv[1]); console.log(adapter.marker);',
      specifier,
    ]);
    expect(stdout.trim()).toBe('synthetic-acp-loaded');
    expect(config).toContain(`path: ${JSON.stringify(join(adapterDir, 'deepseek-agent-presets'))}`);

    const repeated = await readGeneratedConfig(
      await resolveDeepSeekHarnessProcessLaunch({ adapterPath, rootDir })
    );
    expect(repeated).toEqual(await readGeneratedConfig(launch));
  });

  it('publishes and loads the generated ACP config from the resolved Harness home', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lody-dsh-home-'));
    temporaryRoots.push(rootDir);

    const launch = await resolveDeepSeekHarnessProcessLaunch({
      adapterPath: '/bundled/deepseek-acp.js',
      rootDir,
    });
    const { configPath, config } = await readGeneratedConfig(launch);

    expect(dirname(configPath)).toBe(rootDir);
    expect(existsSync(configPath)).toBe(true);
    expect(config).toContain('compression: zstd');
    expect(launch.args).toContain('dsh-acp-demo');
    expect(launch.args).not.toContain('--force');
    expect(launch.args).not.toContain('--legacy-peer-deps');
    expect(launch.args).not.toContain('@deepseek-ai/dsh@0.1.0-rc.6');
    expect(launch.env[DEEPSEEK_HARNESS_HOME_ENV]).toBe(rootDir);
    expect(await readdir(rootDir)).toContain(basename(configPath));
  });

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
    const { config } = await readGeneratedConfig(launch);

    expect(config).toContain('compression: zstd');
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
    const { config } = await readGeneratedConfig(launch);

    expect(config).toContain('compression: none');
    expect(await readFile(artifact, 'utf8')).toBe('raw-jsonl');
  });

  it('rejects mixed roots before publishing config and leaves both artifacts unchanged', async () => {
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
