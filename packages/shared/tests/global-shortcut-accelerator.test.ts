import { describe, expect, it } from 'vitest';

import {
  bindingToElectronAccelerator,
  CliRuntimeStateSchema,
  isDevEmailPasswordLoginEnabled,
  LaunchLocalPathInputSchema,
  migrateLegacyShortcutBinding,
  PathLauncherProbeSchema,
  PathLauncherRequestSchema,
} from '../src/electron-ipc';

describe('bindingToElectronAccelerator', () => {
  it('allows a global shortcut to be unset', () => {
    expect(bindingToElectronAccelerator(null)).toBeNull();
  });

  it('refuses modifier-less bindings (would swallow a bare key OS-wide)', () => {
    expect(bindingToElectronAccelerator('k')).toBeNull();
    expect(bindingToElectronAccelerator('Space')).toBeNull();
    expect(bindingToElectronAccelerator('F2')).toBeNull();
  });

  it('refuses Shift-only bindings that would intercept normal typing OS-wide', () => {
    expect(bindingToElectronAccelerator('Shift+n')).toBeNull();
    expect(bindingToElectronAccelerator('Shift+1')).toBeNull();
    expect(bindingToElectronAccelerator('Shift+F2')).toBeNull();
  });
});

describe('migrateLegacyShortcutBinding', () => {
  it('rewrites only the legacy primary-modifier token', () => {
    expect(migrateLegacyShortcutBinding('$mod+Shift+b')).toBe('Mod+Shift+b');
    expect(migrateLegacyShortcutBinding('Shift+$MOD+k')).toBe('Shift+Mod+k');
    expect(migrateLegacyShortcutBinding('Mod+Shift+b')).toBe('Mod+Shift+b');
  });
});

describe('isDevEmailPasswordLoginEnabled', () => {
  it('enables direct email/password login for every unpackaged Electron build', () => {
    expect(isDevEmailPasswordLoginEnabled({ isPackaged: false })).toBe(true);
  });

  it('keeps direct email/password login disabled in packaged Electron builds', () => {
    expect(isDevEmailPasswordLoginEnabled({ isPackaged: true })).toBe(false);
  });
});

describe('LaunchLocalPathInputSchema', () => {
  it('preserves path argument whitespace when parsing command requests', () => {
    const result = LaunchLocalPathInputSchema.safeParse({
      kind: 'command',
      command: { command: 'code', args: ['/tmp/project '] },
      targetPath: '/tmp/project ',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.command.args).toEqual(['/tmp/project ']);
    expect(result.data.targetPath).toBe('/tmp/project ');
  });

  it('rejects NUL bytes in command arguments', () => {
    expect(
      LaunchLocalPathInputSchema.safeParse({
        kind: 'command',
        command: { command: 'code', args: ['/tmp/project\0bad'] },
        targetPath: '/tmp/project',
      }).success
    ).toBe(false);
  });
});

describe('CliRuntimeStateSchema', () => {
  it('accepts backend connection ages and workspace details', () => {
    const payload = {
      schemaVersion: 1,
      phase: 'running',
      startupStage: 'ready',
      connectivity: 'online',
      backend: {
        authorization: 'authorized',
        connection: 'connecting',
      },
      connectionAges: {
        backendNotConnectedSinceMs: 1_000,
        workspaceNotConnectedSinceMs: { 'workspace-1': 2_000 },
      },
      connectedWorkspaces: [
        {
          id: 'workspace-1',
          name: 'Alpha',
          slug: 'alpha',
          role: 'owner',
          backendConnection: 'reconnecting',
        },
      ],
      pid: 123,
      updatedAtMs: 1,
      issues: [],
    } as const;
    const result = CliRuntimeStateSchema.safeParse(payload);

    expect(result.success).toBe(true);

    const legacyV1Schema = CliRuntimeStateSchema.omit({ connectionAges: true });
    expect(legacyV1Schema.safeParse(payload).success).toBe(true);
  });

  it('keeps backend details optional for older daemon runtime payloads', () => {
    expect(
      CliRuntimeStateSchema.safeParse({
        schemaVersion: 1,
        phase: 'running',
        pid: 123,
        updatedAtMs: 1,
        issues: [],
      }).success
    ).toBe(true);
  });
});

describe('renderer launcher authority', () => {
  it('accepts only a launcher id and target, never renderer-supplied commands or URLs', () => {
    const request = { launcherId: 'vscode', targetPath: '/tmp/project', targetKind: 'directory' };
    expect(PathLauncherRequestSchema.parse(request)).toEqual(request);
    for (const extra of [
      { command: { command: 'sh', args: ['-c', 'arbitrary'] } },
      { args: ['-c', 'arbitrary'] },
      { url: 'file:///tmp/script.command' },
      { fallbackCommands: [{ command: 'sh' }] },
    ]) {
      expect(PathLauncherRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
      expect(
        PathLauncherProbeSchema.safeParse({ launchers: [{ ...request, ...extra }] }).success
      ).toBe(false);
    }
    expect(
      PathLauncherRequestSchema.safeParse({
        kind: 'command',
        command: { command: 'sh' },
        targetPath: '/tmp/project',
      }).success
    ).toBe(false);
  });
});
