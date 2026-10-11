import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkClaude,
  checkCodex,
  checkOpencode,
  detectCliTypes,
  __test__,
} from '../src/node/cli-detection';

let tempDirs: string[] = [];

function makeHomeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-cli-detection-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{}\n', 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('CLI auth file detection', () => {
  it('detects Claude Code from ~/.claude.json', () => {
    const homeDir = makeHomeDir();

    expect(checkClaude({ homeDir })).toBe(false);
    expect(__test__.hasClaudeCredentials({ homeDir })).toBe(false);

    writeFile(path.join(homeDir, '.claude.json'));

    expect(checkClaude({ homeDir })).toBe('configured');
    expect(__test__.hasClaudeCredentials({ homeDir })).toBe(true);
  });

  it('detects Claude Code from ~/.claude/ directory as a fallback', () => {
    const homeDir = makeHomeDir();

    expect(checkClaude({ homeDir })).toBe(false);

    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });

    expect(checkClaude({ homeDir })).toBe('configured');
    expect(__test__.hasClaudeCredentials({ homeDir })).toBe(true);
  });

  it('detects Codex from ~/.codex/auth.json by default', () => {
    const homeDir = makeHomeDir();
    const originalCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;

    try {
      expect(checkCodex({ homeDir })).toBe(false);
      expect(__test__.hasCodexCredentials({ homeDir })).toBe(false);

      writeFile(path.join(homeDir, '.codex', 'auth.json'));

      expect(checkCodex({ homeDir })).toBe('configured');
      expect(__test__.hasCodexCredentials({ homeDir })).toBe(true);
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
    }
  });

  it('honors $CODEX_HOME for Codex auth detection', () => {
    const homeDir = makeHomeDir();
    const originalCodexHome = process.env.CODEX_HOME;
    const customCodexHome = path.join(homeDir, 'custom-codex-home');

    try {
      process.env.CODEX_HOME = customCodexHome;

      // Default ~/.codex/auth.json must NOT count when CODEX_HOME points elsewhere.
      writeFile(path.join(homeDir, '.codex', 'auth.json'));
      expect(checkCodex({ homeDir })).toBe(false);

      writeFile(path.join(customCodexHome, 'auth.json'));
      expect(checkCodex({ homeDir })).toBe('configured');
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
    }
  });

  it('returns available CLI types from auth files', () => {
    const homeDir = makeHomeDir();
    const originalCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    try {
      writeFile(path.join(homeDir, '.codex', 'auth.json'));

      expect(detectCliTypes({ homeDir })).toEqual({
        kimi: 'managed-runtime',
        grok: 'managed-runtime',
        claude: null,
        codex: 'configured',
        available: ['kimi', 'grok', 'codex'],
      });
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
    }
  });

  it('keeps an injected empty homeDir instead of falling back to the real home', () => {
    expect(__test__.resolveHomeDir({ homeDir: '' })).toBe('');
  });
});

describe.skipIf(process.platform === 'win32')('CLI version probes', () => {
  function withFakeOpencode(script: string | null): () => void {
    const binDir = makeHomeDir();
    if (script !== null) {
      const binPath = path.join(binDir, 'opencode');
      fs.writeFileSync(binPath, `#!/bin/sh\n${script}\n`, 'utf8');
      fs.chmodSync(binPath, 0o755);
    }
    const originalPath = process.env.PATH;
    // Only the fake bin dir and the system shell: no real opencode can leak in.
    process.env.PATH = [binDir, '/bin', '/usr/bin'].join(path.delimiter);
    return () => {
      process.env.PATH = originalPath;
    };
  }

  it('reports the trimmed version printed by a successful probe', async () => {
    const restore = withFakeOpencode('echo " 1.2.3 "');
    try {
      await expect(checkOpencode()).resolves.toBe('1.2.3');
    } finally {
      restore();
    }
  });

  it('treats a non-zero exit as not installed even when it printed output', async () => {
    const restore = withFakeOpencode('echo 1.2.3; exit 3');
    try {
      await expect(checkOpencode()).resolves.toBe(false);
    } finally {
      restore();
    }
  });

  it('treats a missing binary as not installed', async () => {
    const restore = withFakeOpencode(null);
    try {
      await expect(checkOpencode()).resolves.toBe(false);
    } finally {
      restore();
    }
  });
});
