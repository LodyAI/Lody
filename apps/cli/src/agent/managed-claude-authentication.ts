import { execFile } from 'node:child_process';
import os from 'node:os';
import { isManagedAccountProfile } from './account-profiles';
import { resolveACPProcessLaunchAsync } from './setting';

/** Inspect native settings in an isolated process; never change the daemon's profile env. */
export async function prepareManagedClaudeAuthentication(input: {
  agentType: string;
  accountProfileId?: string;
  executable: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<string> {
  if (input.agentType !== 'claude' || !isManagedAccountProfile(input.accountProfileId))
    return os.homedir();
  const cwd = input.env.CLAUDE_CONFIG_DIR;
  if (!cwd) throw new Error('Managed Claude account home is unavailable');
  input.signal?.throwIfAborted();
  const launch = await resolveACPProcessLaunchAsync({
    cliType: 'builtin',
    agentType: 'claude',
    runtimeOverrides: { claudeCodeExecutable: input.executable },
    extraArgs: ['--lody-check-managed-settings'],
  });
  input.signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    execFile(
      launch.command,
      launch.args,
      {
        cwd,
        env: { ...input.env, ...launch.env },
        signal: input.signal,
        timeout: 15_000,
        maxBuffer: 16_384,
        windowsHide: true,
      },
      (error) => {
        if (error)
          reject(new Error('Managed Claude authentication settings could not be verified'));
        else resolve();
      }
    );
  });
  input.signal?.throwIfAborted();
  return cwd;
}
