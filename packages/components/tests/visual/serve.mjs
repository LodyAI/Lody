/**
 * A static file server for the Storybook build.
 *
 * The visual harness compares frames across two runs of the same stories, so
 * it needs a server that does not change under it: a dev server re-transforms
 * modules and can hand a stale timestamped URL to a page, which renders as an
 * empty frame. A built Storybook is a fixed set of files.
 *
 *   node tests/visual/serve.mjs --root storybook-static --port 6007
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const args = process.argv.slice(2);
const read = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const root = path.resolve(read('root', 'storybook-static'));
const port = Number(read('port', '6007'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

if (!existsSync(root)) {
  console.error(`[visual] ${root} does not exist — build Storybook first`);
  process.exit(1);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) {
    response.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!existsSync(file)) {
    // Storybook's iframe routes are all served by the same index.
    file = path.join(root, 'index.html');
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    // The browser caches the bundle inside a capture context; without this the
    // preview is re-downloaded for every story and the capture crawls.
    'cache-control': 'public, max-age=3600',
  });
  createReadStream(file).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[visual] serving ${root} on http://127.0.0.1:${port}`);
});
