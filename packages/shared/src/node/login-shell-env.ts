/**
 * The user's login-shell environment, probed once through the process layer.
 *
 * GUI and daemon launches (macOS launchd, Linux .desktop, systemd, npx) inherit
 * a minimal PATH without the directories users install tools into (Homebrew,
 * nvm, volta, `~/.local/bin`, editor CLIs). Both the CLI and the desktop read
 * the login shell's environment to recover them; this is their one probe.
 */
import { userInfo } from 'node:os';

import { Duration } from 'effect';

import {
  CommandTimedOut,
  READ_ONLY_ABANDON_POLICY,
  runCommandTextLegacy,
  type ProcessFacadeOptions,
} from './process';

const DELIMITER = '_LODY_SHELL_ENV_DELIMITER_';
/** Verbose rc files (`set -x`) write to stderr; that must not fail the probe. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/**
 * Rc files (nvm, conda, oh-my-zsh) can take seconds on a cold login; a shell
 * past this is stuck. One budget for the whole probe, fallbacks included.
 */
const DEFAULT_TIMEOUT = Duration.seconds(15);
/** POSIX shells to try when the default one fails (for example Nushell). */
const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash'];

/**
 * The script each shell runs. `command env` skips aliases and functions named
 * `env`; `-0` keeps values with newlines intact, with plain `env` for one
 * without it (BusyBox); the delimiters separate the environment from whatever
 * the rc files print. They go through `printf`: macOS `/bin/sh` prints
 * `echo -n X` as `-n X` plus a newline. Interactive login bash reads
 * `~/.bash_profile` but not `~/.bashrc`, where most PATH edits live.
 */
const probeScript = (shell: string): string =>
  `${shell.endsWith('/bash') ? 'source ~/.bashrc >/dev/null 2>&1 || true; ' : ''}` +
  `printf '%s' "${DELIMITER}"; command env -0 2>/dev/null || command env; printf '%s' "${DELIMITER}"; exit`;

/**
 * Keep rc files from blocking the probe (oh-my-zsh auto-update, tmux
 * autostart). The shell prints them back; they are not the user's settings.
 */
const PROBE_ENV: Record<string, string> = {
  DISABLE_AUTO_UPDATE: 'true',
  ZSH_TMUX_AUTOSTARTED: 'true',
  ZSH_TMUX_AUTOSTART: 'false',
};

export const parseLoginShellEnvOutput = (stdout: string): NodeJS.ProcessEnv | null => {
  const section = stdout.split(DELIMITER)[1];
  if (section === undefined) return null;
  const parsed: NodeJS.ProcessEnv = {};
  for (const entry of section.split(section.includes('\0') ? '\0' : '\n')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    parsed[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
};

/** Undo what the probe itself injected: the base value, or nothing. */
const withoutProbeEnv = (
  parsed: NodeJS.ProcessEnv,
  baseEnv: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const result = { ...parsed };
  for (const key of Object.keys(PROBE_ENV)) {
    if (baseEnv[key] === undefined) delete result[key];
    else result[key] = baseEnv[key];
  }
  return result;
};

const defaultShell = (env: NodeJS.ProcessEnv): string => {
  try {
    const { shell } = userInfo();
    if (shell) return shell;
  } catch {
    // No passwd entry (a container user); fall back to the environment.
  }
  return env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
};

export interface LoginShellEnvOptions {
  /**
   * The whole probe's budget, fallback shells included (15 s by default). A
   * shell still running at the deadline is ended with its process tree.
   */
  readonly timeout?: Duration.Input;
  /** The environment the shell starts from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to the user's login shell. */
  readonly shell?: string;
  readonly processOptions?: ProcessFacadeOptions;
}

/**
 * Run the login shell interactively and return the environment it ends with,
 * or null (Windows, or no shell produced one). A shell that fails to start or
 * exits unsuccessfully falls back to zsh, then bash; a shell that times out
 * does not, because its rc files are what hung.
 */
export const probeLoginShellEnv = async (
  options: LoginShellEnvOptions
): Promise<NodeJS.ProcessEnv | null> => {
  if (process.platform === 'win32') return null;
  const baseEnv = options.env ?? process.env;
  const first = options.shell ?? defaultShell(baseEnv);
  const shells = [first, ...FALLBACK_SHELLS.filter((shell) => shell !== first)];
  const deadline = Date.now() + Duration.toMillis(options.timeout ?? DEFAULT_TIMEOUT);
  for (const shell of shells) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return null;
    try {
      const output = await runCommandTextLegacy(
        {
          command: shell,
          args: ['-ilc', probeScript(shell)],
          env: { ...baseEnv, ...PROBE_ENV },
          timeout: remainingMs,
          // An interactive shell ignores SIGTERM; a grace period only delays.
          abandonPolicy: READ_ONLY_ABANDON_POLICY,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          check: 'exit-0',
        },
        options.processOptions
      );
      const parsed = parseLoginShellEnvOutput(output.stdout);
      if (parsed) return withoutProbeEnv(parsed, baseEnv);
    } catch (error) {
      if (error instanceof CommandTimedOut) return null;
    }
  }
  return null;
};
