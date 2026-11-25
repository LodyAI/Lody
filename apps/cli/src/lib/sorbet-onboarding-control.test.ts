import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  describeImportSource,
  disconnectSorbetProvider,
  extractKeyLast4,
  pickRecommendedSorbetModel,
  probeSorbetArrival,
  readConnectionSources,
  recordConnectionSource,
  runSorbetImportSource,
  scanEnvCandidatesFromMap,
} from './sorbet-onboarding-control';

describe('sorbet-onboarding-control', () => {
  const tempDirs: string[] = [];

  function makeTempRoot(): { root: string; sorbetDir: string; homeDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'lody-sorbet-onboarding-'));
    tempDirs.push(root);
    const sorbetDir = join(root, 'sorbet');
    const homeDir = join(root, 'home');
    mkdirSync(sorbetDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    return { root, sorbetDir, homeDir };
  }

  afterAll(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('probes an empty Sorbet data directory as model.kind = "none" with advertised OAuth methods', async () => {
    const { sorbetDir } = makeTempRoot();
    const probe = await probeSorbetArrival({ sorbetDataDir: sorbetDir });

    expect(probe.model.kind).toBe('none');
    expect(probe.connectedProviders).toEqual([]);
    expect(Array.isArray(probe.methods)).toBe(true);
    expect(probe.methods.length).toBeGreaterThan(0);
  });

  it('persists only non-secret provenance metadata and cleans up on disconnect', async () => {
    const { root, sorbetDir } = makeTempRoot();
    recordConnectionSource(
      'anthropic',
      {
        kind: 'imported',
        from: 'claude-code',
        authKind: 'api_key',
        last4: extractKeyLast4('sk-ant-api03-synthetic-secret-9f2a'),
      },
      sorbetDir
    );

    const sourcesPath = join(root, 'sorbet-connection-sources.json');
    const rawText = readFileSync(sourcesPath, 'utf8');
    expect(rawText).not.toContain('synthetic-secret');
    expect(readConnectionSources(sorbetDir).anthropic).toMatchObject({
      kind: 'imported',
      from: 'claude-code',
      authKind: 'api_key',
      last4: '9f2a',
    });

    await disconnectSorbetProvider('anthropic', { sorbetDataDir: sorbetDir });
    expect(readConnectionSources(sorbetDir).anthropic).toBeUndefined();
  });

  it('picks recommended default models per provider without requiring a model picker step', () => {
    const picked = pickRecommendedSorbetModel(
      [
        {
          selector: 'anthropic/claude-3-haiku',
          providerId: 'anthropic',
          modelId: 'claude-3-haiku',
          displayName: 'Claude Haiku',
        },
        {
          selector: 'anthropic/claude-sonnet-4-5',
          providerId: 'anthropic',
          modelId: 'claude-sonnet-4-5',
          displayName: 'Claude Sonnet 4.5',
        },
      ],
      'anthropic'
    );
    expect(picked?.selector).toBe('anthropic/claude-sonnet-4-5');
  });

  it('pre-discloses macOS Keychain prompt only on darwin for claude-code', () => {
    expect(describeImportSource('claude-code', 'darwin')).toEqual({
      source: 'claude-code',
      systemPromptKind: 'macos-keychain',
    });
    expect(describeImportSource('claude-code', 'linux')).toEqual({
      source: 'claude-code',
      systemPromptKind: 'none',
    });
    expect(describeImportSource('codex', 'darwin')).toEqual({
      source: 'codex',
      systemPromptKind: 'none',
    });
  });

  it('detects rotating OAuth credentials in Claude Code and Codex as oauth_conflict instead of copying refresh tokens', async () => {
    const { sorbetDir, homeDir } = makeTempRoot();
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(
      join(homeDir, '.claude', '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'synthetic-access',
          refreshToken: 'synthetic-rotating-refresh',
        },
      })
    );

    const claudeResult = await runSorbetImportSource(
      { source: 'claude-code' },
      {
        homeDir,
        sorbetDataDir: sorbetDir,
        readKeychain: async () => ({ status: 'not_found' }),
      }
    );
    expect(claudeResult).toEqual({
      status: 'oauth_conflict',
      source: 'claude-code',
      providerId: 'anthropic',
      providerName: 'Claude',
    });

    mkdirSync(join(homeDir, '.codex'), { recursive: true });
    writeFileSync(
      join(homeDir, '.codex', 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'synthetic-access',
          refresh_token: 'synthetic-rotating-refresh',
        },
      })
    );

    const codexResult = await runSorbetImportSource(
      { source: 'codex' },
      { homeDir, sorbetDataDir: sorbetDir }
    );
    expect(codexResult).toEqual({
      status: 'oauth_conflict',
      source: 'codex',
      providerId: 'openai-codex',
      providerName: 'ChatGPT',
    });
  });

  it('imports static API keys from Claude Code and Codex into Sorbet and turns ArrivalProbe ready', async () => {
    const { sorbetDir, homeDir } = makeTempRoot();
    writeFileSync(
      join(homeDir, '.claude.json'),
      JSON.stringify({
        primaryApiKey: 'sk-ant-api03-synthetic-static-key-77c1',
      })
    );

    const imported = await runSorbetImportSource(
      { source: 'claude-code' },
      {
        homeDir,
        sorbetDataDir: sorbetDir,
        readKeychain: async () => ({ status: 'not_found' }),
      }
    );

    expect(imported.status).toBe('imported');
    if (imported.status === 'imported') {
      expect(imported.providerId).toBe('anthropic');
      expect(imported.connectionSource).toMatchObject({
        kind: 'imported',
        from: 'claude-code',
        authKind: 'api_key',
        last4: '77c1',
      });
    }

    const probeAfter = await probeSorbetArrival({ sorbetDataDir: sorbetDir });
    expect(probeAfter.model.kind).toBe('ready');
    if (probeAfter.model.kind === 'ready') {
      expect(probeAfter.model.provider).toBe('anthropic');
      expect(probeAfter.model.model).toContain('anthropic/');
    }
  });

  it('scans shell environment candidates exposing only variable name and last 4 characters', async () => {
    const { sorbetDir } = makeTempRoot();
    const candidates = scanEnvCandidatesFromMap({
      ANTHROPIC_API_KEY: 'sk-ant-api03-synthetic-env-key-48b2',
      OPENAI_API_KEY: 'sk-proj-synthetic-openai-key-19d0',
      UNRELATED_SECRET: 'should-not-appear',
    });

    expect(candidates).toEqual([
      {
        envName: 'ANTHROPIC_API_KEY',
        providerId: 'anthropic',
        providerName: 'Anthropic',
        last4: '48b2',
      },
      {
        envName: 'OPENAI_API_KEY',
        providerId: 'openai',
        providerName: 'OpenAI',
        last4: '19d0',
      },
    ]);

    const scanResult = await runSorbetImportSource(
      { source: 'env', mode: 'scan' },
      {
        sorbetDataDir: sorbetDir,
        readShellEnv: async () => ({
          OPENAI_API_KEY: 'sk-proj-synthetic-openai-key-19d0',
        }),
      }
    );
    expect(scanResult).toEqual({
      status: 'env_candidates',
      candidates: [
        {
          envName: 'OPENAI_API_KEY',
          providerId: 'openai',
          providerName: 'OpenAI',
          last4: '19d0',
        },
      ],
    });
  });
});
