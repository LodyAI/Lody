import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecoveryDeviceSecret, importRecoveryDevice } from '../src/recovery-device';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(
  mode: string,
  dir: string,
  variant = 'ok'
): Promise<{ status: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, join(here, 'ledger-recovery-child.ts'), mode, dir, variant],
      { cwd: join(here, '..'), stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status: status ?? 1, stderr }));
  });
}

describe('R backup material and two-process restore', () => {
  it('imports a non-extractable daily handle from exported PKCS8 secret', async () => {
    const created = await createRecoveryDeviceSecret();
    const handle = await importRecoveryDevice(created.secret);
    expect(handle.publicKey).toEqual(created.publicKey);
    expect(handle.enc).toEqual(created.enc);
    await expect(
      crypto.subtle.exportKey('pkcs8', handle.recipientKeyPair.privateKey)
    ).rejects.toThrow();
    const message = crypto.getRandomValues(new Uint8Array(32));
    const signature = await handle.sign(message);
    expect(signature.byteLength).toBe(64);
  });

  it('restores R from file backup in a second process without owner handles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lody-r-restore-'));
    dirs.push(dir);
    const setup = await run('setup', dir);
    expect(setup.status, setup.stderr).toBe(0);
    const restore = await run('restore', dir);
    expect(restore.status, restore.stderr).toBe(0);
    const result = JSON.parse(readFileSync(join(dir, 'restore.json'), 'utf8')) as {
      recoveredEpochs: number[];
      newLength: number;
      canEndorse: boolean;
    };
    expect(result.recoveredEpochs).toEqual([0, 1]);
    expect(result.newLength).toBe(4);
    expect(result.canEndorse).toBe(true);
  });

  it('restores from snapshot materials without prefix records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lody-r-snap-'));
    dirs.push(dir);
    const setup = await run('setup', dir);
    expect(setup.status, setup.stderr).toBe(0);
    unlinkSync(join(dir, 'records.bin'));
    unlinkSync(join(dir, 'genesis.bin'));
    const restore = await run('restore-snapshot', dir);
    expect(restore.status, restore.stderr).toBe(0);
    const result = JSON.parse(readFileSync(join(dir, 'restore.json'), 'utf8')) as {
      origin: string;
      recoveredEpochs: number[];
      newLength: number;
      canEndorse: boolean;
    };
    expect(result.origin).toBe('snapshot');
    expect(result.recoveredEpochs).toEqual([0, 1]);
    expect(result.newLength).toBe(4);
    expect(result.canEndorse).toBe(true);
  });

  it('fails restore when R is revoked, membership is removed, the current packet is missing, or the backup is damaged', async () => {
    for (const variant of [
      'revoke-r',
      'missing-envelope',
      'bad-backup',
      'remove-member',
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), `lody-r-${variant}-`));
      dirs.push(dir);
      const setup = await run('setup', dir, variant);
      expect(setup.status, setup.stderr).toBe(0);
      const restore = await run('restore', dir, variant);
      expect(restore.status, `${variant}: ${restore.stderr}`).not.toBe(0);
    }
  });

  it('fails snapshot restore when R is revoked, membership is removed, the packet is missing, or the backup is damaged', async () => {
    for (const variant of [
      'revoke-r',
      'missing-envelope',
      'bad-backup',
      'remove-member',
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), `lody-r-snap-${variant}-`));
      dirs.push(dir);
      const setup = await run('setup', dir, variant);
      expect(setup.status, setup.stderr).toBe(0);
      unlinkSync(join(dir, 'records.bin'));
      const restore = await run('restore-snapshot', dir, variant);
      expect(restore.status, `${variant}: ${restore.stderr}`).not.toBe(0);
    }
  });
});
