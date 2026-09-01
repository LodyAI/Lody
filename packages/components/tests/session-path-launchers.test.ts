import { describe, expect, it } from 'vitest';
import { pathLauncherPreferenceSchema } from '../src/lib/local-storage-cache';
import {
  buildPathLauncherLaunchInput,
  buildPathLauncherProbes,
  buildVSCodePathLauncherFallbackUrl,
  getAvailablePathLauncherOptions,
  getCustomPathLauncherOptionId,
  validateCustomPathLauncherCommandTemplate,
  type CustomPathLauncher,
} from '../src/lib/session-path-launchers';

describe('path launcher preferences', () => {
  it('parses a stored preference and defaults missing custom launchers', () => {
    expect(pathLauncherPreferenceSchema.parse({ selectedLauncherId: 'cursor' })).toEqual({
      selectedLauncherId: 'cursor',
      customLaunchers: [],
    });
  });
});

describe('getAvailablePathLauncherOptions', () => {
  it('shows Xcode only in Electron on macOS', () => {
    expect(
      getAvailablePathLauncherOptions({
        customLaunchers: [],
        isElectron: true,
        platform: 'darwin',
      }).some((launcher) => launcher.kind === 'builtin' && launcher.id === 'xcode')
    ).toBe(true);

    expect(
      getAvailablePathLauncherOptions({
        customLaunchers: [],
        isElectron: true,
        platform: 'linux',
      }).some((launcher) => launcher.kind === 'builtin' && launcher.id === 'xcode')
    ).toBe(false);
  });

  it('shows Sublime Text on every desktop OS but not on the web', () => {
    const hasSublime = (platform: string, isElectron: boolean) =>
      getAvailablePathLauncherOptions({ customLaunchers: [], isElectron, platform }).some(
        (launcher) => launcher.kind === 'builtin' && launcher.id === 'sublime'
      );

    expect(hasSublime('darwin', true)).toBe(true);
    expect(hasSublime('win32', true)).toBe(true);
    expect(hasSublime('linux', true)).toBe(true);
    expect(hasSublime('darwin', false)).toBe(false);
  });

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
  it('requires the path placeholder', () => {
    expect(validateCustomPathLauncherCommandTemplate('code-insiders .')).toEqual({
      ok: false,
      reason: 'missing_path',
    });
  });

  it('rejects invalid quoting', () => {
    expect(validateCustomPathLauncherCommandTemplate('code "{path}')).toEqual({
      ok: false,
      reason: 'invalid_syntax',
    });
  });

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

  it('skips invalid stored custom launchers during availability checks', () => {
    expect(
      buildPathLauncherProbes(
        [
          {
            id: 'broken',
            kind: 'custom',
            launcherId: getCustomPathLauncherOptionId('broken'),
            label: 'Broken',
            commandTemplate: 'broken-without-a-path',
          },
        ],
        '/Users/me/project'
      )
    ).toEqual([]);
  });
});

describe('built-in path launchers', () => {
  it('builds an xed launch request for Xcode', () => {
    const xcode = getAvailablePathLauncherOptions({
      customLaunchers: [],
      isElectron: true,
      platform: 'darwin',
    }).find((launcher) => launcher.kind === 'builtin' && launcher.id === 'xcode');

    expect(xcode).toBeDefined();
    expect(buildPathLauncherLaunchInput(xcode!, '/Users/me/project')).toEqual({
      kind: 'command',
      command: { command: '/usr/bin/xed', args: ['/Users/me/project'] },
      fallbackCommands: [{ command: 'xed', args: ['/Users/me/project'] }],
      targetPath: '/Users/me/project',
      label: 'Xcode',
    });
  });

  it('builds platform-specific Sublime Text launch requests', () => {
    const getSublime = (platform: string) =>
      getAvailablePathLauncherOptions({ customLaunchers: [], isElectron: true, platform }).find(
        (launcher) => launcher.kind === 'builtin' && launcher.id === 'sublime'
      );

    const mac = getSublime('darwin');
    expect(mac).toBeDefined();
    expect(buildPathLauncherLaunchInput(mac!, '/Users/me/project', 'darwin')).toEqual({
      kind: 'command',
      command: { command: '/usr/bin/open', args: ['-a', 'Sublime Text', '/Users/me/project'] },
      fallbackCommands: [
        { command: 'subl', args: ['/Users/me/project'] },
        { command: '/usr/local/bin/subl', args: ['/Users/me/project'] },
      ],
      targetPath: '/Users/me/project',
      label: 'Sublime Text',
    });

    const windows = getSublime('win32');
    expect(buildPathLauncherLaunchInput(windows!, 'C:\\code\\app', 'win32')).toEqual({
      kind: 'command',
      command: { command: 'subl', args: ['C:\\code\\app'] },
      fallbackCommands: [
        { command: 'C:\\Program Files\\Sublime Text\\subl.exe', args: ['C:\\code\\app'] },
        { command: 'C:\\Program Files\\Sublime Text\\sublime_text.exe', args: ['C:\\code\\app'] },
        { command: 'C:\\Program Files\\Sublime Text 3\\sublime_text.exe', args: ['C:\\code\\app'] },
      ],
      targetPath: 'C:\\code\\app',
      label: 'Sublime Text',
    });

    const linux = getSublime('linux');
    expect(buildPathLauncherLaunchInput(linux!, '/home/me/project', 'linux').command).toEqual({
      command: 'subl',
      args: ['/home/me/project'],
    });
  });

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

  it('encodes a Windows workspace path for the VS Code new-window deeplink', () => {
    expect(buildVSCodePathLauncherFallbackUrl('C:\\Users\\me\\My #Project?')).toBe(
      'vscode://file/C:/Users/me/My%20%23Project%3F/?windowId=_blank'
    );
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

  it('keeps Warp on the url launch path opening a new tab', () => {
    const warp = getEditor('warp', 'darwin');
    expect(buildPathLauncherLaunchInput(warp!, '/Users/me/My Project', 'darwin')).toEqual({
      kind: 'url',
      url: 'warp://action/new_tab?path=%2FUsers%2Fme%2FMy%20Project',
      targetPath: '/Users/me/My Project',
      label: 'Warp',
    });
  });

  it('exposes no built-in launchers on the web (desktop bridge only)', () => {
    expect(
      getAvailablePathLauncherOptions({ customLaunchers: [], isElectron: false, platform: 'darwin' })
    ).toEqual([]);
  });
});
