/**
 * Lody-owned Git and gh adapters run under the runtime executing this CLI, not
 * whatever `node` the user's PATH provides. Desktop builds ship no `node` on
 * PATH, and their Electron runtime behaves as Node only while
 * ELECTRON_RUN_AS_NODE is set.
 */
export type HostNodeRuntime = { execPath: string; electron: boolean };

export const resolveHostNodeRuntime = (): HostNodeRuntime => ({
  execPath: process.execPath,
  electron: Boolean(process.versions.electron),
});

const quoteShell = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** POSIX shell command that runs a script under the host runtime; arguments may follow. */
export const buildHostNodeCommand = (
  scriptPath: string,
  runtime = resolveHostNodeRuntime()
): string => {
  const command = `${quoteShell(runtime.execPath)} ${quoteShell(scriptPath)}`;
  return runtime.electron ? `ELECTRON_RUN_AS_NODE=1 ${command}` : command;
};

/**
 * Opening lines of a file that is both a POSIX sh launcher and a CommonJS
 * script. sh re-executes the file under the host runtime; Node strips the
 * hashbang and reads `':'` as a directive followed by a line comment, so a
 * following 'use strict' still applies and `__filename` stays the launcher.
 * Shebangs cannot carry paths with spaces, which packaged runtimes have.
 */
export const buildHostNodeScriptPreamble = (runtime = resolveHostNodeRuntime()): string => {
  if (/[\r\n]/.test(runtime.execPath)) {
    throw new Error('The Lody runtime path cannot contain line breaks');
  }
  const electron = runtime.electron ? 'ELECTRON_RUN_AS_NODE=1; export ELECTRON_RUN_AS_NODE; ' : '';
  return `#!/bin/sh\n':' //; ${electron}exec ${quoteShell(runtime.execPath)} "$0" "$@"\n`;
};
