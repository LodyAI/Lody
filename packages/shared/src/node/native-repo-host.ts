import { mkdir } from 'node:fs/promises';
import { ensureEngineHost } from '@loro-dev/loro-repo-client/node';

/** Stop after this long with no connected client. */
export const NATIVE_REPO_HOST_IDLE_MS = 60_000;
const EXIT_POLL_MS = 500;

/**
 * The separate host process. `files.lock` makes it unique: a second launch
 * attaches as a client and exits. It keeps no client of its own, so the engine
 * idles out after the last daemon or desktop connection closes.
 */
export async function runNativeRepoHost(
  dataDir: string,
  addon: Parameters<typeof ensureEngineHost>[0]['addon']
): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const host = await ensureEngineHost({
    addon,
    dataDir,
    idleMs: NATIVE_REPO_HOST_IDLE_MS,
    clientOptions: { autoReconnect: false },
  });
  const engine = host.engine;
  await host.client.close();
  if (!engine) return;
  const stop = () => engine.stop();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (!engine.exited) return;
      clearInterval(timer);
      resolve();
    }, EXIT_POLL_MS);
  });
}
