import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const ports = vi.hoisted(() => ({
  login: vi.fn(),
  preflight: vi.fn(),
  host: vi.fn(),
  autostart: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({
  AuthClient: class {},
  performLoginWithAuthCredential: ports.login,
}));
vi.mock('@/lib/cli-platform', () => ({ getCliPlatformKind: () => 'cloud' }));
vi.mock('./daemon-auth-preflight', () => ({ ensureDaemonBackendAuth: ports.preflight }));
vi.mock('@lody/shared/node/local-cli-host-lease', () => ({
  inspectLocalCliHost: ports.host,
  requestLocalCliHostUpgrade: vi.fn(),
}));
vi.mock('./daemon-autostart', async (original) => ({
  ...(await original<typeof import('./daemon-autostart')>()),
  registerDaemonAutostart: ports.autostart,
}));
import { installManagedDaemon } from './daemon-install';
const roots: string[] = [];
beforeEach(() => {
  ports.host.mockResolvedValue(null);
  ports.preflight.mockResolvedValue({ status: 'authenticated' });
});
afterEach(async () => {
  Reflect.deleteProperty(globalThis, Symbol.for('lody.sea.context'));
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-install-command-'));
  roots.push(root);
  const data = path.join(root, 'profile with spaces');
  vi.stubEnv('LODY_DATA_DIR', data);
  const events = path.join(root, 'events');
  const capsule = path.join(root, 'downloaded');
  const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
  await fs.writeFile(capsule, `#!/bin/sh\nprintf 'started:%s\\n' "$*" >> ${quote(events)}\n`, {
    mode: 0o700,
  });
  Reflect.set(globalThis, Symbol.for('lody.sea.context'), {
    metadata: {
      format: 1,
      product: 'lody-cloud',
      distribution: 'lody-cloud-daemon',
      version: '1.2.3',
      channel: 'stable',
      platform: `${process.platform}-${process.arch}`,
      serviceProtocol: 1,
      payloadSha256: 'a'.repeat(64),
      node: { sha256: 'b'.repeat(64), size: 1, version: '26.13.0' },
    },
    capsulePath: capsule,
    releaseDir: path.join(root, 'payload'),
    nodePath: process.execPath,
  });
  return {
    root,
    data,
    events,
    capsule,
    service: path.join(
      data,
      'daemon-managed',
      process.platform === 'win32' ? 'service.exe' : 'service'
    ),
  };
}
it.skipIf(process.platform === 'win32')(
  'authenticates before starting the installed fixed entry, never passes the credential to its child, and survives unavailable autostart',
  async () => {
    const f = await fixture();
    const credential = 'lody_pair_synthetic_private';
    ports.login.mockImplementation(async () => {
      await fs.appendFile(f.events, 'authenticated\n');
      return { success: true };
    });
    ports.autostart.mockRejectedValue(new Error('No user service manager'));
    await installManagedDaemon({ auth: credential, start: true, autostart: true });
    expect(await fs.readFile(f.service)).toEqual(await fs.readFile(f.capsule));
    expect(await fs.readFile(f.events, 'utf8')).toBe(
      'authenticated\nstarted:daemon start --skip-auth-check\n'
    );
    const record = await fs.readFile(
      path.join(f.data, 'daemon-managed', 'installation.json'),
      'utf8'
    );
    expect(JSON.parse(record).service).toBe(f.service);
    expect(record).not.toContain(credential);
  }
);
it('a rejected credential leaves an installed entry but never registers or starts an unauthorized daemon', async () => {
  const f = await fixture();
  ports.login.mockResolvedValue({ success: false, error: 'Expired synthetic credential' });
  await expect(
    installManagedDaemon({ auth: 'synthetic', start: true, autostart: true })
  ).rejects.toThrow(/Expired/);
  expect(await fs.readFile(f.service)).toEqual(await fs.readFile(f.capsule));
  await expect(fs.access(f.events)).rejects.toThrow();
});
it('refuses to replace files or credentials while another Host owns this profile', async () => {
  const f = await fixture();
  ports.host.mockResolvedValue({ pid: 42, mode: 'electron' });
  await expect(installManagedDaemon({ auth: 'synthetic', start: true })).rejects.toThrow(
    /Stop the existing/
  );
  await expect(fs.access(path.join(f.data, 'daemon-managed'))).rejects.toThrow();
});

it('generic non-interactive installation does not bypass required authentication', async () => {
  const f = await fixture();
  ports.preflight.mockResolvedValue({
    status: 'failed',
    message: 'Use a pairing credential in non-interactive mode',
  });
  await expect(installManagedDaemon({ start: true })).rejects.toThrow(/pairing credential/);
  await expect(fs.access(f.events)).rejects.toThrow();
});
