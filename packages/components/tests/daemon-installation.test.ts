import { DEFAULT_RUNTIME_ARTIFACTS_BASE_URL } from '@lody/platform';
import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.unstubAllGlobals());
import { buildDaemonInstallCommands } from '../src/lib/daemon-installation';
it('pairs through official standalone installers, keeps Nightly/next selection and quotes credentials separately from URLs', () => {
  const result = buildDaemonInstallCommands({
    auth: "lody_pair_synthetic'$(echo unsafe)",
    channel: 'nightly',
  });
  expect(result.command).toContain(
    `'${new URL('/install.sh', DEFAULT_RUNTIME_ARTIFACTS_BASE_URL).href}'`
  );
  expect(result.command).toContain("--channel 'nightly'");
  expect(result.command).toContain("--auth 'lody_pair_synthetic'\"'\"'$(echo unsafe)'");
  expect(result.windowsCommand).toContain("-Auth 'lody_pair_synthetic''$(echo unsafe)'");
  expect(result.windowsCommand).toContain(
    `'${new URL('/install.ps1', DEFAULT_RUNTIME_ARTIFACTS_BASE_URL).href}'`
  );
  expect(buildDaemonInstallCommands({ channel: 'staging' }).command).toContain("--channel 'next'");
  expect(() => buildDaemonInstallCommands({ auth: 'bad\ncredential' })).toThrow();
});

it.each([
  ['stable', 'stable'],
  ['staging', 'next'],
  ['nightly', 'nightly'],
])('uses the %s client build to choose the %s initial release', (build, expected) => {
  vi.stubGlobal('__DESKTOP_RELEASE_CHANNEL__', build);
  expect(buildDaemonInstallCommands().command).toContain(`--channel '${expected}'`);
});
