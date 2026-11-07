import { describe, expect, it } from 'vitest';
import {
  normalizeMachineUpgradeTargetVersion,
  resolveMachineLifecycleCapability,
} from './machine-lifecycle';

describe('machine lifecycle helpers', () => {
  it('defaults upgrade target to latest', () => {
    expect(normalizeMachineUpgradeTargetVersion()).toBe('latest');
    expect(normalizeMachineUpgradeTargetVersion('  latest  ')).toBe('latest');
  });

  it('accepts exact semver-like upgrade targets', () => {
    expect(normalizeMachineUpgradeTargetVersion('1.2.3')).toBe('1.2.3');
    expect(normalizeMachineUpgradeTargetVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1');
  });

  it('rejects arbitrary npm package specs', () => {
    expect(() => normalizeMachineUpgradeTargetVersion('git+https://example.com/repo.git')).toThrow(
      /exact semver/
    );
    expect(() => normalizeMachineUpgradeTargetVersion('file:/tmp/lody.tgz')).toThrow(
      /exact semver/
    );
    expect(() => normalizeMachineUpgradeTargetVersion('next')).toThrow(/exact semver/);
  });

  it('legacy daemons require explicit migration instead of remote npm installation', () => {
    expect(resolveMachineLifecycleCapability('daemon')).toEqual({
      launchMode: 'daemon',
      canRemoteRestart: true,
      canRemoteUpgrade: false,
      reason: 'unsupported_install',
    });
  });

  it('disables remote lifecycle for Electron managed CLI', () => {
    expect(resolveMachineLifecycleCapability('electron')).toEqual({
      launchMode: 'electron',
      canRemoteRestart: false,
      canRemoteUpgrade: false,
      reason: 'electron',
    });
  });

  it('disables remote lifecycle for foreground lody start', () => {
    expect(resolveMachineLifecycleCapability(undefined)).toEqual({
      launchMode: 'foreground',
      canRemoteRestart: false,
      canRemoteUpgrade: false,
      reason: 'not_daemon',
    });
  });
});

describe('managed lifecycle capability', () => {
  it('requires a managed plaintext daemon with proven process containment', () => {
    expect(
      resolveMachineLifecycleCapability('daemon', { managed: true, platform: 'linux' })
        .canRemoteUpgrade
    ).toBe(true);
    expect(
      resolveMachineLifecycleCapability('daemon', { managed: true, encrypted: true })
        .canRemoteUpgrade
    ).toBe(false);
    expect(
      resolveMachineLifecycleCapability('daemon', { managed: true, platform: 'win32' })
        .canRemoteUpgrade
    ).toBe(false);
  });
});

// Installation safety: a successful shutdown receipt must include retained
// detached groups even when their original root has already exited.
