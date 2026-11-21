import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/agent/login-shell-env', () => ({ getLoginShellEnvLegacy: async () => ({}) }));

import {
  EVERME_NODE_VERSION,
  ensureEverMeNode,
  evermeNodeBinDir,
  evermeNodeDir,
  withEverMeNode,
} from './everme-node';

describe('EverMe managed Node.js', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'everme-node-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('NODEJS_ORG_MIRROR', '');
    vi.stubEnv('NVM_NODEJS_ORG_MIRROR', '');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  it('rejects an archive that is not the pinned build, whichever source served it', async () => {
    vi.stubEnv('NODEJS_ORG_MIRROR', 'http://mirror.test/dist/');
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(url);
      // A source that controls its own checksum list would have passed here.
      return url.endsWith('SHASUMS256.txt')
        ? new Response('0'.repeat(64))
        : new Response('not the Node.js that was published');
    });
    await expect(ensureEverMeNode()).rejects.toThrow('does not match the pinned checksum');
    expect(requested.map((url) => new URL(url).origin)).toEqual([
      'http://mirror.test',
      'https://nodejs.org',
    ]);
    expect(requested.every((url) => url.includes(`/${EVERME_NODE_VERSION}/node-`))).toBe(true);
    // Nothing was unpacked, nothing was left behind, and no shell was touched.
    expect(existsSync(evermeNodeDir())).toBe(false);
    expect(await readdir(path.join(home, '.everme'))).toEqual([]);
    expect((await readdir(home)).sort()).toEqual(['.everme']);
  });

  it('leaves commands untouched on a machine that never needed it', () => {
    const env = { PATH: '/usr/bin', npm_config_prefix: '/opt/npm' };
    expect(withEverMeNode(env)).toBe(env);
  });

  it('puts its own Node.js first and owns the npm prefix once it exists', async () => {
    await mkdir(evermeNodeBinDir(), { recursive: true });
    const key = process.platform === 'win32' ? 'Path' : 'PATH';
    const result = withEverMeNode({ [key]: '/usr/bin' });
    expect(result[key]).toBe([evermeNodeBinDir(), '/usr/bin'].join(path.delimiter));
    expect(result.npm_config_prefix).toBe(evermeNodeDir());
  });
});
