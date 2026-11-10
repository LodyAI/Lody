import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerDaemonAutostart } from './daemon-autostart';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-install-service-'));
  roots.push(home);
  return {
    home,
    dataDir: path.join(home, 'data with & spaces'),
    service: path.join(home, 'data with & spaces', 'service'),
  };
}
it('registers the fixed absolute Mac entry for next login, preserves the installation profile and never starts another host', async () => {
  const options = await fixture();
  const result = await registerDaemonAutostart({
    ...options,
    platform: 'darwin',
    run: async () => {
      throw new Error('Must not spawn on registration');
    },
  });
  const directory = path.join(options.home, 'Library', 'LaunchAgents');
  const files = await fs.readdir(directory);
  const file = path.join(directory, files[0] ?? '');
  const installed = await fs.readFile(file, 'utf8');
  expect(installed).toContain('data with &amp; spaces');
  expect(installed).toContain('<string>daemon-runner</string>');
  expect(result).toContain('Login autostart registered');
  await registerDaemonAutostart({ ...options, platform: 'darwin' });
  expect(await fs.readFile(file, 'utf8')).toBe(installed);
  await fs.writeFile(file, 'user-owned configuration');
  await expect(registerDaemonAutostart({ ...options, platform: 'darwin' })).rejects.toThrow(
    /preserved/
  );
  expect(await fs.readFile(file, 'utf8')).toBe('user-owned configuration');
});
it('enables a user Linux unit without starting it, preserves percent/space paths, and leaves unavailable managers recoverable', async () => {
  const options = await fixture();
  options.dataDir += '%profile';
  const commands: string[][] = [];
  await registerDaemonAutostart({
    ...options,
    platform: 'linux',
    run: async (command, args) => {
      commands.push([command, ...args]);
    },
  });
  const directory = path.join(options.home, '.config', 'systemd', 'user');
  const [name] = await fs.readdir(directory);
  expect(await fs.readFile(path.join(directory, name ?? ''), 'utf8')).toContain('%%profile');
  expect(commands).toEqual([
    ['systemctl', '--user', 'show', '--property=Version', '--value'],
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', name],
  ]);
  const unavailable = await fixture();
  await expect(
    registerDaemonAutostart({
      ...unavailable,
      platform: 'linux',
      run: async () => {
        throw new Error('No user bus');
      },
    })
  ).rejects.toThrow('No user bus');
  await expect(fs.access(path.join(unavailable.home, '.config'))).rejects.toThrow();
});
