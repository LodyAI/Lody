import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommandTextLegacy } from '@lody/shared/node/process';
import { installCommandShim } from './command-shim';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it.skipIf(process.platform === 'win32')(
  'installer exposes lody on PATH via a marked shim and an idempotent profile block',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-command-shim-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const bin = path.join(home, '.local', 'bin');
    const service = path.join(root, 'service');
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(service, '#!/bin/sh\nprintf \'%s\\n\' "$*"\n', { mode: 0o700 });
    const env = {
      PATH: '/usr/bin',
      HOME: home,
      SHELL: '/bin/bash',
      LODY_DATA_DIR: path.join(root, 'data with spaces'),
    };
    const first = await installCommandShim(service, { env, home });
    const second = await installCommandShim(service, { env, home });
    expect(first).toMatchObject({ status: 'installed', pathModified: true, pathOnPath: false });
    expect(second).toMatchObject({ status: 'installed', pathModified: false, pathOnPath: false });
    const profile = await fs.readFile(path.join(home, '.profile'), 'utf8');
    expect(profile.match(/# Added by Lody installer/g)).toHaveLength(1);
    expect((await fs.readFile(path.join(bin, 'lody'), 'utf8')).split('\n')[1]).toBe(
      '# lody-managed-shim v1'
    );
    const result = await runCommandTextLegacy(
      {
        command: path.join(bin, 'lody'),
        args: ['--help', 'two words'],
        env: { ...process.env, ...env },
        check: 'exit-0',
      },
      {}
    );
    expect(result.stdout).toBe('--help two words\n');
    const sourced = await runCommandTextLegacy(
      {
        command: '/bin/sh',
        args: ['-c', `. ${path.join(home, '.profile')}; printf '%s\\n' "$PATH"`],
        env: { ...process.env, ...env },
        check: 'exit-0',
      },
      {}
    );
    expect(sourced.stdout.split(':')).toContain(bin);
  }
);

it.skipIf(process.platform === 'win32')(
  'installer never replaces or shadows a foreign lody',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-command-conflict-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const foreign = path.join(root, 'foreign');
    await fs.mkdir(foreign, { recursive: true });
    await fs.writeFile(path.join(foreign, 'lody'), '#!/bin/sh\n', { mode: 0o700 });
    const result = await installCommandShim('/tmp/service', {
      env: { PATH: foreign, HOME: home, SHELL: '/bin/bash' },
      home,
    });
    expect(result.status).toBe('conflict');
    await expect(fs.access(path.join(home, '.profile'))).rejects.toThrow();
    await expect(fs.access(path.join(home, '.local', 'bin', 'lody'))).rejects.toThrow();
  }
);

it.skipIf(process.platform === 'win32')(
  '--no-modify-path writes the shim without editing shell profiles',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-command-no-path-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const service = path.join(root, 'service');
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(service, '#!/bin/sh\n', { mode: 0o700 });
    const result = await installCommandShim(service, {
      noModifyPath: true,
      env: { PATH: '/usr/bin', HOME: home, SHELL: '/bin/bash' },
      home,
    });
    expect(result.status).toBe('installed');
    await expect(fs.access(path.join(home, '.profile'))).rejects.toThrow();
    await expect(fs.access(path.join(home, '.local', 'bin', 'lody'))).resolves.toBeUndefined();
  }
);
