import { describe, expect, it } from 'vitest';
import { pathLauncherPreferenceSchema } from '../src/lib/local-storage-cache';
import {
  buildPathLauncherLaunchInput,
  buildPathLauncherProbes,
  getAvailablePathLauncherOptions,
  getCustomPathLauncherOptionId,
  type CustomPathLauncher,
} from '../src/lib/session-path-launchers';

describe('getAvailablePathLauncherOptions', () => {
  it('shows custom command launchers only in Electron', () => {
    const customLaunchers: CustomPathLauncher[] = [
      { id: 'phpstorm', label: 'PhpStorm', commandTemplate: 'open -a "PhpStorm" {path}' },
    ];

    expect(
      getAvailablePathLauncherOptions({
        customLaunchers,
        isElectron: true,
        platform: 'darwin',
      }).some((launcher) => launcher.kind === 'custom' && launcher.label === 'PhpStorm')
    ).toBe(true);

    expect(
      getAvailablePathLauncherOptions({
        customLaunchers,
        isElectron: false,
        platform: 'darwin',
      }).some((launcher) => launcher.kind === 'custom')
    ).toBe(false);
  });
});

describe('custom path launcher command templates', () => {
  it('builds command launch inputs without shell splitting the path', () => {
    const launcher: CustomPathLauncher = {
      id: 'code-insiders',
      label: 'Code Insiders',
      commandTemplate: 'code-insiders --reuse-window {path}',
    };

    expect(
      buildPathLauncherLaunchInput(
        {
          ...launcher,
          kind: 'custom',
          launcherId: getCustomPathLauncherOptionId(launcher.id),
        },
        '/Users/me/My Project'
      )
    ).toEqual({
      kind: 'command',
      command: {
        command: 'code-insiders',
        args: ['--reuse-window', '/Users/me/My Project'],
      },
      targetPath: '/Users/me/My Project',
      label: 'Code Insiders',
    });
  });
});

describe('built-in path launchers', () => {
  it.each(['darwin', 'linux', 'win32'])(
    'opens a Delta worktree on %s with the path as one argument',
    (platform) => {
      const options = getAvailablePathLauncherOptions({
        customLaunchers: [],
        isElectron: true,
        platform,
      });
      const delta = options.find(
        (launcher) => launcher.kind === 'builtin' && launcher.id === 'delta'
      );
      expect(delta).toBeDefined();
      const targetPath =
        platform === 'win32' ? 'C:\\code\\My Project' : '/tmp/My Project; $(echo example)';
      const input = buildPathLauncherLaunchInput(delta!, targetPath, platform);
      expect(input).toEqual({
        kind: 'command',
        command: { command: 'delta', args: ['open', targetPath] },
        targetPath,
        label: 'Delta',
      });
      expect(buildPathLauncherProbes([delta!], targetPath, platform)).toEqual([
        { launcherId: 'delta', input },
      ]);
      expect(
        pathLauncherPreferenceSchema.parse({ selectedLauncherId: 'delta' }).selectedLauncherId
      ).toBe('delta');
      expect(
        getAvailablePathLauncherOptions({
          customLaunchers: [],
          isElectron: false,
          platform,
        }).some((launcher) => launcher.kind === 'builtin' && launcher.id === 'delta')
      ).toBe(false);
    }
  );

  const getEditor = (id: string, platform: string) =>
    getAvailablePathLauncherOptions({ customLaunchers: [], isElectron: true, platform }).find(
      (launcher) => launcher.kind === 'builtin' && launcher.id === id
    );

  it('opens VS Code in a new window via its CLI on macOS', () => {
    const vscode = getEditor('vscode', 'darwin');
    expect(vscode).toBeDefined();
    expect(buildPathLauncherLaunchInput(vscode!, '/Users/me/My Project', 'darwin')).toEqual({
      kind: 'command',
      command: { command: 'code', args: ['-n', '/Users/me/My Project'] },
      fallbackCommands: [
        { command: '/usr/local/bin/code', args: ['-n', '/Users/me/My Project'] },
        {
          command: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
          args: ['-n', '/Users/me/My Project'],
        },
      ],
      fallbackUrl: 'vscode://file/Users/me/My%20Project/?windowId=_blank',
      targetPath: '/Users/me/My Project',
      label: 'VS Code',
    });
  });

  it('keeps a DMG file URL distinct from a directory URL', () => {
    const vscode = getEditor('vscode', 'darwin');
    expect(
      buildPathLauncherLaunchInput(vscode!, '/tmp/My Build/Lody.dmg', 'darwin', 'file')
    ).toMatchObject({
      fallbackUrl: 'vscode://file/tmp/My%20Build/Lody.dmg?windowId=_blank',
    });
  });

  it('opens Cursor in a new window via its CLI on Linux', () => {
    const cursor = getEditor('cursor', 'linux');
    expect(buildPathLauncherLaunchInput(cursor!, '/home/me/project', 'linux')).toEqual({
      kind: 'command',
      command: { command: 'cursor', args: ['-n', '/home/me/project'] },
      fallbackCommands: [
        { command: '/usr/bin/cursor', args: ['-n', '/home/me/project'] },
        { command: '/opt/cursor/cursor', args: ['-n', '/home/me/project'] },
      ],
      targetPath: '/home/me/project',
      label: 'Cursor',
    });
  });

  it('opens Zed without a new-window flag so it focuses an already-open worktree', () => {
    const zed = getEditor('zed', 'linux');
    expect(zed).toBeDefined();
    expect(buildPathLauncherLaunchInput(zed!, '/home/me/project', 'linux')).toEqual({
      kind: 'command',
      command: { command: 'zed', args: ['/home/me/project'] },
      fallbackCommands: [
        { command: '/usr/bin/zed', args: ['/home/me/project'] },
        { command: '/usr/local/bin/zed', args: ['/home/me/project'] },
      ],
      targetPath: '/home/me/project',
      label: 'Zed',
    });
  });

  it('exposes no built-in launchers on the web (desktop bridge only)', () => {
    expect(
      getAvailablePathLauncherOptions({
        customLaunchers: [],
        isElectron: false,
        platform: 'darwin',
      })
    ).toEqual([]);
  });
});
