import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticHost } from './static-host.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(packageRoot, 'out', 'client');
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '127.0.0.1';

const server = createStaticHost({ root, port, host });
await server.listen();
console.log(`Static host (Cloudflare Pages equivalent) http://${host}:${port}/`);
console.log(`Serving ${root}`);
