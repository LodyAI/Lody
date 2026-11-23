import fs from 'fs';
import path from 'path';
import * as os from 'os';
import type { CliType } from '../ai';
import { CommandFailed, runCommandTextLegacy } from './process';

const CLI_VERSION_COMMAND_TIMEOUT_MS = 5_000;

function uniqNonEmpty(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v && v.trim() !== '')));
}

function buildAugmentedPath(additionalPaths: string[], basePath: string | undefined): string {
  return [...additionalPaths, basePath || ''].join(path.delimiter);
}

function getWindowsGlobalBinPaths(): string[] {
  // Common global shim locations for npm/pnpm/yarn on Windows.
  const home = os.homedir();
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  // Fallback to ~/AppData/Roaming when %APPDATA% is not set.
  const appDataFallback = path.join(home, 'AppData', 'Roaming');
  const effectiveAppData = appData || appDataFallback;
  return uniqNonEmpty([
    path.join(effectiveAppData, 'npm'),
    appData ? path.join(appData, 'pnpm') : path.join(appDataFallback, 'pnpm'),
    localAppData ? path.join(localAppData, 'Yarn', 'bin') : undefined,
    localAppData ? path.join(localAppData, 'Microsoft', 'WindowsApps') : undefined,
    // Custom npm global prefix (set via `npm config set prefix ~/npm-global`).
    path.join(home, 'npm-global'),
  ]);
}

function parseRawVersion(output: string): string {
  return output.trim();
}

function selectWindowsWhereCandidate(paths: string[]): string | null {
  const normalized = paths.map((p) => p.trim()).filter(Boolean);
  if (normalized.length === 0) return null;

  const preferExt = ['.exe', '.cmd', '.bat', '.com'];
  const lower = normalized.map((p) => p.toLowerCase());
  for (const ext of preferExt) {
    const idx = lower.findIndex((p) => p.endsWith(ext));
    if (idx >= 0) return normalized[idx] ?? null;
  }

  // Fall back to the first entry (even if it's a .ps1) to preserve legacy behavior.
  return normalized[0] ?? null;
}

function quoteCmdArg(arg: string): string {
  // Minimal quoting for cmd.exe /c; good enough for our fixed version args and full paths.
  if (arg === '') return '""';
  if (!/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

type CliCommandResult = {
  stdout: string;
  status: number | null;
  error?: Error;
};

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<CliCommandResult> {
  try {
    const result = await runCommandTextLegacy({
      command,
      args,
      env,
      timeout: CLI_VERSION_COMMAND_TIMEOUT_MS,
      check: 'exit-0',
    });
    return {
      stdout: result.stdout,
      status: 0,
    };
  } catch (error) {
    // A non-zero exit keeps its status and stdout; a spawn failure (ENOENT),
    // a timeout or an output overflow has no exit status.
    if (error instanceof CommandFailed) {
      return { stdout: error.stdout, status: error.code, error };
    }
    return {
      stdout: '',
      status: null,
      ...(error instanceof Error ? { error } : {}),
    };
  }
}

async function runWindowsCommandResolved(
  binName: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<CliCommandResult> {
  // Prefer the non-PowerShell shim (.cmd/.exe) even when PowerShell execution policy blocks .ps1 shims.
  const where = await runCommand(
    'cmd.exe',
    ['/d', '/s', '/c', `where ${quoteCmdArg(binName)}`],
    env
  );

  const stdout = String(where.stdout ?? '');
  const candidates = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let resolved = selectWindowsWhereCandidate(candidates);

  // [Defensive patch] When `cmd.exe /c where` cannot find the binary, try PowerShell's
  // Get-Command as a fallback. Some Windows setups (e.g. certain winget installations or
  // environments where the binary is only visible in PowerShell's PATH) may have the
  // command available to PowerShell but not to cmd.exe. This is speculative — we are not
  // certain it resolves any specific reported issue, so it can be safely removed if it
  // proves unhelpful or causes problems.
  if (!resolved) {
    try {
      const ps = await runCommand(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-Command ${binName} -ErrorAction SilentlyContinue).Source`],
        env
      );
      const psPath = String(ps.stdout ?? '').trim();
      if (ps.status === 0 && psPath) {
        resolved = psPath;
      }
    } catch {
      // Ignore — PowerShell may not be available either.
    }
  }

  if (!resolved) {
    return await runCommand(binName, args, env);
  }

  const resolvedLower = resolved.toLowerCase();
  if (
    resolvedLower.endsWith('.cmd') ||
    resolvedLower.endsWith('.bat') ||
    resolvedLower.endsWith('.com')
  ) {
    const cmdline = [quoteCmdArg(resolved), ...args.map(quoteCmdArg)].join(' ');
    return await runCommand('cmd.exe', ['/d', '/s', '/c', cmdline], env);
  }

  if (resolvedLower.endsWith('.ps1')) {
    // ExecutionPolicy can be Restricted on some machines; bypass it for this one-off invocation.
    // We also avoid loading profiles to prevent failures when the user's profile cannot be loaded.
    const cmdline = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args].map(
      quoteCmdArg
    );
    return await runCommand('powershell.exe', cmdline, env);
  }

  return await runCommand(resolved, args, env);
}

const AUTH_FILE_DETECTED = 'configured';

export type CliDetectionOptions = {
  homeDir?: string;
};

function resolveHomeDir(options?: CliDetectionOptions): string {
  return options?.homeDir ?? os.homedir();
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check whether Claude Code has been initialized on this machine. We don't
 * execute `claude --version` because the binary may not be in this process'
 * PATH. Detection accepts either:
 *   - `~/.claude.json` (config/state file written on first `claude` run), or
 *   - `~/.claude/` directory (older installs / credential-only state).
 */
function getClaudeConfigPath(homeDir: string): string {
  return path.join(homeDir, '.claude.json');
}

function getClaudeHomeDir(homeDir: string): string {
  return path.join(homeDir, '.claude');
}

function hasClaudeCredentials(options?: CliDetectionOptions): boolean {
  const homeDir = resolveHomeDir(options);
  return isFile(getClaudeConfigPath(homeDir)) || isDirectory(getClaudeHomeDir(homeDir));
}

function getCodexCredentialsPath(homeDir: string): string {
  const codexHome = process.env.CODEX_HOME;
  if (codexHome && codexHome.length > 0) {
    return path.join(codexHome, 'auth.json');
  }
  return path.join(homeDir, '.codex', 'auth.json');
}

function hasCodexCredentials(options?: CliDetectionOptions): boolean {
  return isFile(getCodexCredentialsPath(resolveHomeDir(options)));
}

export const checkClaude = (options?: CliDetectionOptions): string | false => {
  return hasClaudeCredentials(options) ? AUTH_FILE_DETECTED : false;
};

export const checkCodex = (options?: CliDetectionOptions): string | false => {
  return hasCodexCredentials(options) ? AUTH_FILE_DETECTED : false;
};

export const checkOpencode = async (): Promise<string | false> => {
  try {
    const additionalPaths = process.platform === 'win32' ? getWindowsGlobalBinPaths() : [];
    const PATH = buildAugmentedPath(additionalPaths, process.env.PATH);
    const env = { ...process.env, PATH };

    const { stdout, status, error } =
      process.platform === 'win32'
        ? await runWindowsCommandResolved('opencode', ['-v'], env)
        : await runCommand('opencode', ['-v'], env);

    if (status !== 0 || error) return false;
    return parseRawVersion(String(stdout ?? ''));
  } catch {
    return false;
  }
};

export const checkKimi = async (): Promise<string | false> => {
  try {
    const additionalPaths = process.platform === 'win32' ? getWindowsGlobalBinPaths() : [];
    const PATH = buildAugmentedPath(additionalPaths, process.env.PATH);
    const env = { ...process.env, PATH };

    const { stdout, status, error } =
      process.platform === 'win32'
        ? await runWindowsCommandResolved('kimi', ['-V'], env)
        : await runCommand('kimi', ['-V'], env);

    if (status !== 0 || error) return false;
    return parseRawVersion(String(stdout ?? ''));
  } catch {
    return false;
  }
};

export type CliDetectionResult = {
  kimi: string;
  grok: string;
  claude: string | null;
  codex: string | null;
  available: CliType[];
};

export function detectCliTypes(options?: CliDetectionOptions): CliDetectionResult {
  const kimi = 'managed-runtime';
  const grok = 'managed-runtime';
  const claude = checkClaude(options);
  const codex = checkCodex(options);
  const available: CliType[] = ['kimi', 'grok'];
  if (claude) available.push('claude');
  if (codex) available.push('codex');
  return {
    kimi,
    grok,
    claude: claude || null,
    codex: codex || null,
    available,
  };
}

// Exported for tests.
export const __test__ = {
  resolveHomeDir,
  selectWindowsWhereCandidate,
  parseRawVersion,
  getClaudeConfigPath,
  getClaudeHomeDir,
  getCodexCredentialsPath,
  hasClaudeCredentials,
  hasCodexCredentials,
};
