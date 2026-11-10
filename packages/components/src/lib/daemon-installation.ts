import { DEFAULT_RUNTIME_ARTIFACTS_BASE_URL } from '@lody/platform';
import { collectClientBuildInfo } from './client-build-info';

const shQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";

/** Credentials are shell arguments, never part of a public installer URL. */
export function buildDaemonInstallCommands(
  options: {
    auth?: string;
    channel?: string;
    baseUrl?: string;
  } = {}
): { command: string; windowsCommand: string } {
  const selected = options.channel ?? collectClientBuildInfo().releaseChannel;
  const channel =
    selected === 'nightly'
      ? 'nightly'
      : selected === 'staging' || selected === 'next'
        ? 'next'
        : 'stable';
  const base = options.baseUrl ?? DEFAULT_RUNTIME_ARTIFACTS_BASE_URL;
  const shellUrl = new URL('/install.sh', base).href;
  const psUrl = new URL('/install.ps1', base).href;
  if (options.auth !== undefined && (!options.auth || /[\x00-\x1f\x7f]/.test(options.auth)))
    throw new Error('Invalid machine pairing credential');
  const shellAuth = options.auth ? ` --auth ${shQuote(options.auth)}` : '';
  const psAuth = options.auth ? ` -Auth ${psQuote(options.auth)}` : '';
  return {
    command: `curl -fsSL ${shQuote(shellUrl)} | sh -s -- --channel ${shQuote(channel)}${shellAuth}`,
    windowsCommand: `& ([scriptblock]::Create((irm ${psQuote(psUrl)}))) -Channel ${psQuote(channel)}${psAuth}`,
  };
}
