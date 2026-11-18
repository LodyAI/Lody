import { mkdir, chmod, lstat } from 'node:fs/promises';
import { startEngine, engineVersion } from '@loro-dev/loro-repo-engine';

// Only the fixed daemon supervisor starts this entry. Renderers and one-shot
// commands never decide ownership by racing to open the same data directory.
if (!process.send || !process.connected || !process.argv[2]) {
  throw new Error('Native Repo host requires its supervisor IPC');
}
if (engineVersion().package !== '0.1.0' || engineVersion().protocol !== 2)
  throw new Error('Native Repo engine version mismatch');
const dataDir = process.argv[2];
let engine: ReturnType<typeof startEngine> | undefined;
let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  engine?.stop();
  if (process.connected) process.disconnect();
};
process.once('disconnect', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.on('message', (message) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'stop')
    stop();
});
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const stat = await lstat(dataDir);
if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid native Repo directory');
await chmod(dataDir, 0o700);
if (!stopped && process.connected) {
  engine = startEngine({ dataDir });
  process.send?.({ type: 'ready', version: '0.1.0' });
}
