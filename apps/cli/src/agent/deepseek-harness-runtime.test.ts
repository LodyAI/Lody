import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
