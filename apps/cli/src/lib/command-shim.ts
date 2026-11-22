import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
import { runCommandTextLegacy } from '@lody/shared/node/process';
import { toShared } from '@/platform/process-options';
import { getWindowsPowerShellExecutable, ps } from './powershell';

const SHIM_MARKER = 'lody-managed-shim v1';
const PATH_MARKER = '# Added by Lody installer';

export type CommandShimOptions = {
  noModifyPath?: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  shell?: string;
};

export type CommandShimResult =
  | {
      status: 'installed';
      path: string;
      binDir: string;
      pathOnPath: boolean;
      pathModified: boolean;
    }
  | { status: 'conflict'; path: string }
  | { status: 'failed'; path: string };

export type CommandShimPorts = {
  writeWindowsPath: (directory: string) => Promise<boolean>;
  warn: (message: string) => void;
};

const defaultPorts: CommandShimPorts = {
  writeWindowsPath: async (directory) => {
    const script = `
$ErrorActionPreference = 'Stop'
$directory = ${ps(directory)}
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($null -eq $key) { throw 'Could not open the current-user environment registry key' }
try {
  $value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $paths = if ($value) { [string]$value -split ';' | Where-Object { $_ } } else { @() }
  if (-not ($paths | Where-Object { [StringComparer]::OrdinalIgnoreCase.Equals($_, $directory) })) {
    $paths += $directory
    $key.SetValue('Path', ($paths -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
    $changed = $true
  } else {
    $changed = $false
  }
} finally {
  $key.Dispose()
}
[Environment]::SetEnvironmentVariable('LODY_PATH_REFRESH', $null, 'User')
if ($changed) { '1' } else { '0' }
`;
    const result = await runCommandTextLegacy(
      {
        command: getWindowsPowerShellExecutable(),
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        check: 'exit-0',
        timeout: 15_000,
      },
      toShared()
    );
    return result.stdout.trim() === '1';
  },
  warn: (message) => console.warn(message),
};

const isRegularFile = async (file: string): Promise<boolean> => {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
};

const isExecutableFile = async (file: string, platform: NodeJS.Platform): Promise<boolean> => {
  try {
    if (!(await isRegularFile(file))) return false;
    if (platform !== 'win32') await fs.access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const isMarkedShim = async (file: string): Promise<boolean> => {
  try {
    return (await fs.readFile(file, 'utf8')).includes(SHIM_MARKER);
  } catch {
    return false;
  }
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

const shellDoubleQuote = (value: string): string =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`;

const shellPath = (directory: string, home: string): string => {
  const resolvedDirectory = path.resolve(directory);
  const resolvedHome = path.resolve(home);
  const relative = path.relative(resolvedHome, resolvedDirectory);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) {
    const suffix = relative.split(path.sep).join('/');
    return suffix ? `"$HOME/${shellDoubleQuote(suffix).slice(1, -1)}"` : '"$HOME"';
  }
  return shellDoubleQuote(resolvedDirectory);
};

const samePath = (a: string, b: string, platform: NodeJS.Platform): boolean => {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const left = pathApi.resolve(a);
  const right = pathApi.resolve(b);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};

const profileBlock = (directory: string, home: string): string => {
  const value = shellPath(directory, home);
  const unwrapped = value.slice(1, -1);
  return `${PATH_MARKER}
case ":$PATH:" in
  *":${value}:"*) ;;
  *) export PATH="${unwrapped}:$PATH" ;;
esac
`;
};

const manualPathLine = (directory: string): string =>
  `export PATH=${shellQuote(directory)}:"$PATH"`;

async function appendProfileBlock(
  file: string,
  directory: string,
  home: string,
  ports: CommandShimPorts
): Promise<boolean> {
  try {
    let content = '';
    try {
      content = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (content.includes(PATH_MARKER)) return false;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(
      file,
      `${content && !content.endsWith('\n') ? '\n' : ''}${profileBlock(directory, home)}\n`
    );
    return true;
  } catch {
    ports.warn(
      `Could not update ${file}; add ${manualPathLine(directory)} to your shell profile manually.`
    );
    return false;
  }
}

async function writePath(
  directory: string,
  options: Required<Pick<CommandShimOptions, 'env' | 'home' | 'platform' | 'shell'>>,
  ports: CommandShimPorts
): Promise<boolean> {
  const delimiter = options.platform === 'win32' ? ';' : path.delimiter;
  const pathEntries = (options.env.PATH ?? '').split(delimiter).map((entry) => entry || '.');
  const pathOnPath = pathEntries.some((entry) => samePath(entry, directory, options.platform));
  if (pathOnPath) return false;
  if (options.platform === 'win32') {
    try {
      return await ports.writeWindowsPath(directory);
    } catch {
      ports.warn(
        `Could not update the user PATH; add ${directory} to PATH manually, then open a new terminal.`
      );
      return false;
    }
  }

  const shell = path.basename(options.shell);
  let modified = false;
  const files = [
    path.join(options.home, '.profile'),
    ...(shell === 'bash' || (await isRegularFile(path.join(options.home, '.bashrc')))
      ? [path.join(options.home, '.bashrc')]
      : []),
    ...(shell === 'zsh' || (await isRegularFile(path.join(options.home, '.zshrc')))
      ? [path.join(options.home, '.zshrc')]
      : []),
  ];
  for (const file of files)
    modified = (await appendProfileBlock(file, directory, options.home, ports)) || modified;
  if (shell === 'fish') {
    const file = path.join(options.home, '.config', 'fish', 'conf.d', 'lody.fish');
    try {
      let content = '';
      try {
        content = await fs.readFile(file, 'utf8');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (!content.includes(PATH_MARKER)) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(
          file,
          `${content && !content.endsWith('\n') ? '\n' : ''}${PATH_MARKER}\nfish_add_path -g ${shellQuote(directory)}\n`
        );
        modified = true;
      }
    } catch {
      ports.warn(
        `Could not update ${file}; add ${manualPathLine(directory)} to your shell profile manually.`
      );
    }
  }
  return modified;
}

const shimContents = (service: string, platform: NodeJS.Platform, dataDir?: string): string => {
  if (platform === 'win32') {
    const escapedService = service.replaceAll('"', '""');
    const dataLine = dataDir ? `set "LODY_DATA_DIR=${dataDir.replaceAll('"', '""')}"\r\n` : '';
    return `@echo off\r\nrem ${SHIM_MARKER}\r\n${dataLine}"${escapedService}" %*\r\n`;
  }
  const escapedService = shellQuote(service);
  const dataLine = dataDir ? `export LODY_DATA_DIR=${shellQuote(dataDir)}\n` : '';
  return `#!/bin/sh\n# ${SHIM_MARKER}\n${dataLine}exec ${escapedService} "$@"\n`;
};

export async function installCommandShim(
  service: string,
  options: CommandShimOptions = {},
  ports: Partial<CommandShimPorts> = {}
): Promise<CommandShimResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const shell = options.shell ?? env.SHELL ?? '';
  const effectivePorts = { ...defaultPorts, ...ports };
  const bin = env.XDG_BIN_HOME || path.join(home, '.local', 'bin');
  const shimPath = platform === 'win32' ? path.win32.join(bin, 'lody.cmd') : path.join(bin, 'lody');
  const marked = await isMarkedShim(shimPath);
  const names =
    platform === 'win32' ? ['lody', 'lody.exe', 'lody.cmd', 'lody.bat', 'lody.ps1'] : ['lody'];
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  for (const entry of (env.PATH ?? '').split(delimiter).map((value) => value || '.')) {
    for (const name of names) {
      const candidate =
        platform === 'win32' ? path.win32.join(entry, name) : path.join(entry, name);
      if (!(await isExecutableFile(candidate, platform))) continue;
      if (samePath(candidate, shimPath, platform) && marked) continue;
      effectivePorts.warn(
        `Skipped Lody command shim because ${candidate} already exists. Run "${service}" directly or remove the other install (for example, npm uninstall -g lody) and rerun the installer.`
      );
      return { status: 'conflict', path: candidate };
    }
  }
  if ((await isRegularFile(shimPath)) && !marked) {
    effectivePorts.warn(
      `Skipped Lody command shim because ${shimPath} already exists. Run "${service}" directly or remove the other install (for example, npm uninstall -g lody) and rerun the installer.`
    );
    return { status: 'conflict', path: shimPath };
  }
  try {
    await fs.mkdir(bin, { recursive: true, mode: 0o755 });
    const temporary = `${shimPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, shimContents(service, platform, env.LODY_DATA_DIR), {
      mode: 0o755,
    });
    await fs.rename(temporary, shimPath);
    if (platform !== 'win32') await fs.chmod(shimPath, 0o755);
  } catch (error) {
    effectivePorts.warn(`Could not install the Lody command shim at ${shimPath}: ${String(error)}`);
    return { status: 'failed', path: shimPath };
  }
  const noModifyPath = options.noModifyPath || env.LODY_NO_MODIFY_PATH === '1';
  const pathOnPath = (env.PATH ?? '')
    .split(delimiter)
    .map((value) => value || '.')
    .some((entry) => {
      return samePath(entry, bin, platform);
    });
  const pathModified = noModifyPath
    ? false
    : await writePath(bin, { env, home, platform, shell }, effectivePorts);
  return { status: 'installed', path: shimPath, binDir: bin, pathOnPath, pathModified };
}
