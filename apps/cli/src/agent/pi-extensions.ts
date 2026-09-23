import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PiExtensionDiscoverySchema, type PiExtensionDiscovery } from '@lody/shared';
import { getManagedAgentRuntimeManager, PI_EXTENSIONS_SUPPORTED } from './managed-agent-runtime';

const execFileAsync = promisify(execFile);

const SCAN_ENV_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'ELECTRON_RUN_AS_NODE',
] as const;

const PROVIDER_ENV_OVERRIDES = [
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'PI_CODING_AGENT_DIR',
] as const;

export async function discoverManagedPiExtensions(
  providerEnv?: Record<string, string>
): Promise<PiExtensionDiscovery> {
  if (!PI_EXTENSIONS_SUPPORTED) {
    throw new Error(
      'This Pi runtime does not support extension listing. Update the managed runtime.'
    );
  }
  const runtime = await getManagedAgentRuntimeManager().ensureCurrentRuntime('pi', {
    signal: AbortSignal.timeout(120_000),
  });
  const env: Record<string, string> = {};
  for (const key of SCAN_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (process.env.PI_CODING_AGENT_DIR !== undefined) {
    env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
  }
  for (const key of PROVIDER_ENV_OVERRIDES) {
    const value = providerEnv?.[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [runtime.command, '--list-extensions'],
      {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        env,
      }
    );
    return PiExtensionDiscoverySchema.parse(JSON.parse(stdout));
  } catch {
    throw new Error(
      'Pi extension scan failed. Check the saved Pi profile on the execution machine.'
    );
  }
}
