import { describe, expect, it } from 'vitest';
import {
  CliRuntimeStateSchema,
  isDevEmailPasswordLoginEnabled,
  LaunchLocalPathInputSchema,
} from '../src/electron-ipc';

describe('isDevEmailPasswordLoginEnabled', () => {
  it('enables direct email/password login for every unpackaged Electron build', () => {
    expect(isDevEmailPasswordLoginEnabled({ isPackaged: false })).toBe(true);
  });

  it('keeps direct email/password login disabled in packaged Electron builds', () => {
    expect(isDevEmailPasswordLoginEnabled({ isPackaged: true })).toBe(false);
  });
});
describe('LaunchLocalPathInputSchema', () => {
  it('accepts URL launch requests for local path launchers', () => {
    expect(
      LaunchLocalPathInputSchema.safeParse({
        kind: 'url',
        url: 'vscode://file/Users/me/project',
        targetPath: '/Users/me/project',
        label: 'VS Code',
      }).success
    ).toBe(true);
  });

  it('accepts command launch requests with fallback commands', () => {
    expect(
      LaunchLocalPathInputSchema.safeParse({
        kind: 'command',
        command: { command: '/usr/bin/xed', args: ['/Users/me/project'] },
        fallbackCommands: [{ command: 'xed', args: ['/Users/me/project'] }],
        fallbackUrl: 'vscode://file/Users/me/project/?windowId=_blank',
        targetPath: '/Users/me/project',
      }).success
    ).toBe(true);
  });

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
  it('accepts backend authorization and connected workspace details', () => {
    const result = CliRuntimeStateSchema.safeParse({
      schemaVersion: 1,
      phase: 'running',
      startupStage: 'ready',
      connectivity: 'online',
      backend: {
        authorization: 'authorized',
        connection: 'connected',
      },
      connectedWorkspaces: [
        {
          id: 'workspace-1',
          name: 'Alpha',
          slug: 'alpha',
          role: 'owner',
          backendConnection: 'connected',
        },
      ],
      pid: 123,
      updatedAtMs: 1,
      issues: [],
    });

    expect(result.success).toBe(true);
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
