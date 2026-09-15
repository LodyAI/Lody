import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_LOCAL_RESET_REQUEST_TTL_MS,
  clearDesktopLocalResetRequest,
  consumeDesktopLocalResetRequest,
  getDesktopLocalResetRequestPath,
  writeDesktopLocalResetRequest,
} from '../src/node/desktop-local-reset';

const NOW = 1_700_000_000_000;

describe('desktop local reset request path', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the cloud and local installations on disjoint request files', () => {
    vi.stubEnv('LODY_DATA_DIR', '');
    const cloud = getDesktopLocalResetRequestPath('cloud');
    const local = getDesktopLocalResetRequestPath('local');
    expect(cloud).not.toBe(local);
    expect(path.basename(cloud)).toBe('desktop-local-reset.json');
    expect(cloud).toContain(`${path.sep}.lody${path.sep}`);
    expect(local).toContain(`${path.sep}.lody-oss${path.sep}`);
  });
});

describe('arming and consuming a desktop local reset', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-desktop-reset-'));
    filePath = path.join(directory, 'desktop-local-reset.json');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('hands the armed level to the next launch, once', async () => {
    await writeDesktopLocalResetRequest({ mode: 'hard', filePath, nowMs: NOW });

    expect(consumeDesktopLocalResetRequest({ filePath, nowMs: NOW })).toBe('hard');
    // A second launch must not wipe storage again.
    expect(consumeDesktopLocalResetRequest({ filePath, nowMs: NOW })).toBeNull();
  });

  it('creates the data directory and leaves no temporary file behind', async () => {
    const nested = path.join(directory, 'missing', 'desktop-local-reset.json');
    await writeDesktopLocalResetRequest({ mode: 'cache', filePath: nested, nowMs: NOW });

    expect(await fs.readdir(path.dirname(nested))).toEqual(['desktop-local-reset.json']);
    expect(consumeDesktopLocalResetRequest({ filePath: nested, nowMs: NOW })).toBe('cache');
  });

  it('replaces an already armed request instead of leaving two levels pending', async () => {
    await writeDesktopLocalResetRequest({ mode: 'cache', filePath, nowMs: NOW });
    await writeDesktopLocalResetRequest({ mode: 'hard', filePath, nowMs: NOW });

    expect(await fs.readdir(directory)).toEqual(['desktop-local-reset.json']);
    expect(consumeDesktopLocalResetRequest({ filePath, nowMs: NOW })).toBe('hard');
  });

  it('reports nothing to consume and nothing to cancel when none is armed', async () => {
    expect(consumeDesktopLocalResetRequest({ filePath, nowMs: NOW })).toBeNull();
    expect(await clearDesktopLocalResetRequest({ filePath })).toBe(false);
  });

  it('cancels an armed request so the next launch applies nothing', async () => {
    await writeDesktopLocalResetRequest({ mode: 'hard', filePath, nowMs: NOW });

    expect(await clearDesktopLocalResetRequest({ filePath })).toBe(true);
    expect(consumeDesktopLocalResetRequest({ filePath, nowMs: NOW })).toBeNull();
  });

  it('retires a request it refuses, so it cannot be re-evaluated at every launch', async () => {
    for (const contents of [
      'not json',
      JSON.stringify({ version: 2, mode: 'cache', requestedAtMs: NOW }),
      JSON.stringify({ version: 1, mode: 'reinstall', requestedAtMs: NOW }),
      JSON.stringify([{ version: 1, mode: 'cache', requestedAtMs: NOW }]),
      JSON.stringify({ version: 1, mode: 'cache' }),
    ]) {
      await fs.writeFile(filePath, contents, 'utf8');

      expect(consumeDesktopLocalResetRequest({ filePath, nowMs: NOW })).toBeNull();
      await expect(fs.access(filePath)).rejects.toThrow();
    }
  });

  it('ignores a request that is armed but never applied, in either clock direction', async () => {
    for (const drift of [
      DESKTOP_LOCAL_RESET_REQUEST_TTL_MS + 1,
      -DESKTOP_LOCAL_RESET_REQUEST_TTL_MS - 1,
    ]) {
      await writeDesktopLocalResetRequest({ mode: 'hard', filePath, nowMs: NOW });

      expect(consumeDesktopLocalResetRequest({ filePath, nowMs: NOW + drift })).toBeNull();
      await expect(fs.access(filePath)).rejects.toThrow();
    }
  });

  it('still applies a request restarted right at the staleness bound', async () => {
    await writeDesktopLocalResetRequest({ mode: 'cache', filePath, nowMs: NOW });

    expect(
      consumeDesktopLocalResetRequest({
        filePath,
        nowMs: NOW + DESKTOP_LOCAL_RESET_REQUEST_TTL_MS,
      })
    ).toBe('cache');
  });
});
