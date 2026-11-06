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

it('uses the initiating channel hint and rejects a mismatched channel response', async () => {
  vi.stubGlobal('fetch', async (url: string) => {
    expect(url).toContain('/lody-cloud-daemon/channels/darwin-arm64/nightly.json');
    return new Response(
      JSON.stringify({
        payload: JSON.stringify({
          product: 'lody-cloud',
          version: '1.2.3-nightly.4',
          channel: 'nightly',
        }),
      })
    );
  });
  expect(await fetchLatestDaemonVersion('nightly')).toMatchObject({
    ok: true,
    latestVersion: '1.2.3-nightly.4',
  });
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          payload: JSON.stringify({ product: 'lody-cloud', version: '1.2.3', channel: 'stable' }),
        })
      )
  );
  expect((await fetchLatestDaemonVersion('nightly')).ok).toBe(false);
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
