import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startDemoHost } from './host';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return fallback;
}

const dataDir = resolve(arg('--data-dir', '.e2ee-demo-data')!);
const host = arg('--host', '127.0.0.1')!;
const port = Number(arg('--port', '8788'));
const testMode = process.argv.includes('--test');

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const running = await startDemoHost({
  dataDir,
  host,
  port: Number.isFinite(port) ? port : 0,
  testMode,
});
writeFileSync(`${dataDir}/pid`, `${process.pid}\n`);
process.stdout.write(`e2ee-demo listening ${running.baseUrl}\n`);
process.stdout.write(`riverrun ${running.riverrunUrl}\n`);
process.stdout.write(`data ${running.dataDir}\n`);

const shutdown = async () => {
  await running.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
