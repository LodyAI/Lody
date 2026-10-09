import { toShared } from '@/platform/process-options';
import { startProcess } from '@lody/shared/node/process';

type OpenCommand = { readonly command: string; readonly args: readonly string[] };

/**
 * The platform's URL opener as an explicit command. Windows uses the URL
 * protocol handler directly (as Go's `pkg/browser` does) instead of cmd's
 * `start`, so the URL never passes through cmd's metacharacter parsing.
 */
function buildOpenBrowserCommand(url: string, platform: NodeJS.Platform): OpenCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
    default:
      return { command: 'xdg-open', args: [url] };
  }
}

/**
 * Resolves once the opener exits 0. The opener is never terminated: on Linux a
 * browser it starts can stay in its process tree, and must outlive this call.
 */
export async function openBrowser(url: string): Promise<void> {
  const { command, args } = buildOpenBrowserCommand(url, process.platform);
  const handle = startProcess(
    {
      command,
      args,
      // rundll32 passes its show state on to ShellExecute: hidden, a browser or
      // the desktop app cold-started for the URL would open without a window.
      options: { stdio: 'ignore', windowsHide: false },
      processGroup: false,
    },
    toShared()
  );
  let spawnError: unknown;
  handle.child.once('error', (error) => {
    spawnError = error;
  });
  const exit = await handle.exited;
  if (spawnError !== undefined) {
    throw spawnError;
  }
  if (exit.code !== 0) {
    throw new Error(
      `${command} failed to open the browser (${exit.signal ?? `exit ${exit.code}`})`
    );
  }
}
