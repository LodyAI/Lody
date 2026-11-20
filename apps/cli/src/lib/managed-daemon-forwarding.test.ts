import { afterEach, expect, it, vi } from 'vitest';
import type { ManagedInstallation, SeaContext } from './managed-daemon-release';
import { forwardToSelectedManagedInstallation } from './managed-daemon-forwarding';
vi.mock('./managed-daemon-release', () => ({
  getSeaContext: () => null,
  readSelectedInstallation: vi.fn(),
}));

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

const sea: SeaContext = {
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
  capsulePath: '/fixed/service',
  releaseDir: '/embedded/payload',
  nodePath: '/embedded/node',
};

it('lody forwards non-daemon commands to the selected managed release', async () => {
  const installation: ManagedInstallation = {
    version: '1.2.4',
    bin: '/managed/payload/index.js',
    node: '/managed/node',
  };
  const start = vi.fn((_selected, args, _onSignal) => ({
    exited: Promise.resolve({ code: 23, signal: null }),
    args,
  }));
  const forwarded = await forwardToSelectedManagedInstallation(
    ['status', '--json'],
    {
      readSelected: vi.fn(async () => installation),
      start,
    },
    sea
  );
  expect(forwarded).toBe(true);
  expect(start).toHaveBeenCalledWith(installation, ['status', '--json'], expect.any(Function));
  expect(process.exitCode).toBe(23);

  start.mockClear();
  expect(
    await forwardToSelectedManagedInstallation(
      [],
      { readSelected: async () => installation, start },
      sea
    )
  ).toBe(true);
  expect(start).toHaveBeenCalledWith(installation, [], expect.any(Function));
});

it('keeps daemon commands on the fixed service entry', async () => {
  const start = vi.fn();
  expect(await forwardToSelectedManagedInstallation(['daemon', 'status'], { start }, sea)).toBe(
    false
  );
  expect(start).not.toHaveBeenCalled();
});
