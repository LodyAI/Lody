import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isCliVersionOutdated,
  fetchLatestDaemonVersion,
  mintMachineLifecycleRequestToken,
} from '../src/lib/machine-lifecycle-api';

vi.mock('../src/lib/cloud-http-port', () => ({
  requireCloudAuthBaseUrl: () => 'https://auth.fixture.invalid',
}));
afterEach(() => vi.unstubAllGlobals());

describe('isCliVersionOutdated', () => {
  it('treats a prerelease current version as older than the matching stable latest', () => {
    expect(isCliVersionOutdated('1.2.3-beta.1', '1.2.3')).toBe(true);
    expect(isCliVersionOutdated('1.2.3', '1.2.3-beta.1')).toBe(false);
  });
});

const release = {
  format: 1,
  product: 'lody-cloud',
  distribution: 'lody-cloud-daemon',
  version: '1.2.3-nightly.4',
  channel: 'nightly',
  platform: 'darwin-arm64',
  serviceProtocol: 1,
  dataFormat: 1,
  source: 'a'.repeat(40),
  payloadSha256: 'b'.repeat(64),
  nodeVersion: '26.13.0',
  capsule: {
    file: 'daemon.gz',
    sha256: 'c'.repeat(64),
    size: 10,
    contentSha256: 'd'.repeat(64),
    contentSize: 20,
  },
  node: {
    file: 'node.gz',
    sha256: 'e'.repeat(64),
    size: 10,
    contentSha256: 'f'.repeat(64),
    contentSize: 20,
  },
};
it('reads the directly published SHA release manifest for the selected channel', async () => {
  vi.stubGlobal('fetch', async (url: string) => {
    expect(url).toContain('/lody-cloud-daemon/channels/darwin-arm64/nightly.json');
    return Response.json(release);
  });
  expect(await fetchLatestDaemonVersion('nightly')).toMatchObject({
    ok: true,
    latestVersion: release.version,
  });
});
it.each([
  { channel: 'stable' },
  { distribution: 'lody-cloud-next-daemon' },
  { product: 'lody-oss' },
  { platform: 'linux-x64' },
  { serviceProtocol: 2 },
])('rejects release identity or compatibility mismatch: %j', async (change) => {
  vi.stubGlobal('fetch', async () => Response.json({ ...release, ...change }));
  expect((await fetchLatestDaemonVersion('nightly')).ok).toBe(false);
});
it('reads next only from its own distribution', async () => {
  vi.stubGlobal('fetch', async (url: string) => {
    expect(url).toContain('/lody-cloud-next-daemon/channels/darwin-arm64/next.json');
    return Response.json({ ...release, distribution: 'lody-cloud-next-daemon', channel: 'next' });
  });
  expect((await fetchLatestDaemonVersion('next')).ok).toBe(true);
});

it('sends timing and explicit downgrade/channel choices with the exact operation to be signed', async () => {
  const upgrade = {
    protocol: 1 as const,
    channel: 'nightly' as const,
    switchPolicy: 'immediate' as const,
    confirmChannelChange: true,
    confirmDowngrade: true,
  };
  let intent: unknown;
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    intent = JSON.parse(String(options.body));
    return new Response(
      JSON.stringify({ requestToken: 'signed-fixture-token', requesterUserId: 'synthetic-owner' })
    );
  });
  expect(
    await mintMachineLifecycleRequestToken({
      workspaceId: 'synthetic-workspace',
      machineId: 'synthetic-machine',
      action: 'upgrade',
      requestId: 'synthetic-operation',
      targetVersion: '1.2.3-nightly.4',
      upgrade,
      sessionToken: 'synthetic-session',
    })
  ).toMatchObject({ ok: true });
  expect(intent).toEqual({
    workspaceId: 'synthetic-workspace',
    machineId: 'synthetic-machine',
    action: 'upgrade',
    requestId: 'synthetic-operation',
    targetVersion: '1.2.3-nightly.4',
    upgrade,
  });
});
