import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Cloudflare serves this one file for every unknown URL. If the prerendered
 * React app hydrates, the client router boots against the *requested* path
 * and blanks or errors. Keep the document static: meta + markup, no app JS.
 */
export function stripAppHydration(html) {
  return html
    .replace(/<link rel="modulepreload"[^>]*>/gu, '')
    .replace(/<script class="\$tsr"[^>]*>[\s\S]*?<\/script>/gu, '')
    .replace(/<script\b[^>]*\btype="module"[^>]*>[\s\S]*?<\/script>/gu, '');
}

export function finalize404Html(html) {
  const next = stripAppHydration(html);
  if (!next.includes('Page not found | Lody')) {
    throw new Error('404.html is missing the dedicated not-found title');
  }
  if (!next.includes('noindex, follow')) {
    throw new Error('404.html is missing noindex');
  }
  if (/rel="canonical"/u.test(next)) {
    throw new Error('404.html must not include a canonical link');
  }
  if (/<script\b[^>]*\btype="module"/u.test(next)) {
    throw new Error('404.html still contains an app module script');
  }
  return next;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const notFoundPath = path.join(packageRoot, 'out', 'client', '404.html');
  const html = readFileSync(notFoundPath, 'utf8');
  writeFileSync(notFoundPath, finalize404Html(html));
  console.log('Finalized static 404.html (no app hydration)');
}
