import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
};

function decodePathname(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function isInsideRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

function existingFile(root, candidate) {
  if (!isInsideRoot(root, candidate)) return undefined;
  try {
    return statSync(candidate).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a request path the way Cloudflare Pages pretty URLs do. */
export function resolveStaticFile(root, pathname) {
  const decoded = decodePathname(pathname);
  if (decoded.includes('\0') || decoded.includes('..')) return undefined;

  const relative = decoded.replace(/^\/+/u, '');
  const candidates =
    relative === ''
      ? [path.join(root, 'index.html')]
      : [
          path.join(root, relative),
          path.join(root, relative, 'index.html'),
          path.join(root, `${relative.replace(/\/$/u, '')}.html`),
        ];

  const notFoundFile = path.resolve(root, '404.html');
  for (const candidate of candidates) {
    const file = existingFile(root, candidate);
    // Root 404.html is the error document, not a pretty-URL success.
    if (file && path.resolve(file) === notFoundFile) continue;
    if (file) return file;
  }

  return undefined;
}

export function createStaticHost({ root, port = 4173, host = '127.0.0.1' }) {
  const notFoundFile = path.join(root, '404.html');

  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    const file = resolveStaticFile(root, pathname);

    if (file) {
      const ext = path.extname(file);
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME_TYPES[ext] ?? 'application/octet-stream');
      createReadStream(file).pipe(res);
      return;
    }

    if (existsSync(notFoundFile)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      createReadStream(notFoundFile).pipe(res);
      return;
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not Found');
  });

  return {
    host,
    port,
    listen: () =>
      new Promise((resolve) => {
        server.listen(port, host, () => resolve(server));
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
