export function resolvePnpmRunner({
  platform = process.platform,
  execPath = process.execPath,
  npmExecPath = process.env.npm_execpath,
} = {}) {
  const executableName = npmExecPath?.split(/[\\/]/u).at(-1)?.toLowerCase();

  if (executableName && /^pnpm\.(?:c|m)?js$/u.test(executableName)) {
    return { command: execPath, args: [npmExecPath], shell: false };
  }

  if (executableName === 'pnpm' || executableName === 'pnpm.exe') {
    return { command: npmExecPath, args: [], shell: false };
  }

  if (platform === 'win32') {
    throw new Error(
      'Windows cloud package scripts must be launched through pnpm so npm_execpath identifies a safe pnpm entry point'
    );
  }

  return { command: 'corepack', args: ['pnpm'], shell: false };
}
