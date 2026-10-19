import { Effect } from 'effect';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let testHomeDir: string;
let originalLodyDataDir: string | undefined;
let originalLocksDir: string | undefined;

async function loadFileLockModule() {
  return await import('./file-lock');
}

beforeEach(() => {
  testHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-home-'));
  originalLodyDataDir = process.env.LODY_DATA_DIR;
  originalLocksDir = process.env.LODY_LOCKS_DIR;
  delete process.env.LODY_LOCKS_DIR;
  process.env.LODY_DATA_DIR = path.join(testHomeDir, '.lody');
  vi.resetModules();
});

afterEach(() => {
  if (originalLocksDir === undefined) delete process.env.LODY_LOCKS_DIR;
  else process.env.LODY_LOCKS_DIR = originalLocksDir;
  if (originalLodyDataDir === undefined) {
    delete process.env.LODY_DATA_DIR;
  } else {
    process.env.LODY_DATA_DIR = originalLodyDataDir;
  }
  try {
    fs.rmSync(testHomeDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('fileLocksLegacy', () => {
  it('executes fn while holding the lock and releases afterwards', async () => {
    const { fileLocksLegacy } = await loadFileLockModule();

    const lockName = 'basic-lock';
    const locksDir = path.join(testHomeDir, '.lody', 'locks');
    const lockPath = path.join(locksDir, `${lockName}.lock`);

    const result = await fileLocksLegacy.withLock(lockName, async () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number };
      expect(content.pid).toBe(process.pid);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(fs.existsSync(locksDir)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('sanitizes lock name for filesystem safety', async () => {
    const { fileLocksLegacy } = await loadFileLockModule();

    const lockName = 'weird:/\\name*?';
    const safeName = lockName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const locksDir = path.join(testHomeDir, '.lody', 'locks');
    const lockPath = path.join(locksDir, `${safeName}.lock`);

    await fileLocksLegacy.withLock(lockName, async () => {
      expect(fs.existsSync(lockPath)).toBe(true);
    });

    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe('cleanupStaleLocks', () => {
  it('removes stale or invalid lock files but keeps valid ones', async () => {
    const { cleanupStaleLocks, fileLockLayer } = await loadFileLockModule();

    const locksDir = path.join(testHomeDir, '.lody', 'locks');
    fs.mkdirSync(locksDir, { recursive: true });

    const stalePath = path.join(locksDir, 'old.lock');
    const invalidPath = path.join(locksDir, 'invalid.lock');
    const validPath = path.join(locksDir, 'valid.lock');

    fs.writeFileSync(
      stalePath,
      JSON.stringify({
        pid: 999999,
        timestamp: Date.now() - 31 * 60 * 1000,
      })
    );
    fs.writeFileSync(invalidPath, 'not-json');
    fs.writeFileSync(
      validPath,
      JSON.stringify({
        pid: process.pid,
        timestamp: Date.now(),
      })
    );

    await Effect.runPromise(cleanupStaleLocks().pipe(Effect.provide(fileLockLayer)));

    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(invalidPath)).toBe(false);
    expect(fs.existsSync(validPath)).toBe(true);
  });

  it('does not throw if the locks directory is missing', async () => {
    const { cleanupStaleLocks, fileLockLayer } = await loadFileLockModule();

    await expect(
      Effect.runPromise(cleanupStaleLocks().pipe(Effect.provide(fileLockLayer)))
    ).resolves.toBeUndefined();
  });
});
