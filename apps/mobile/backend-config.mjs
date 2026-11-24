import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const defaults = {
  CONVEX_URL: 'https://convex.lody.ai',
  CONVEX_SITE_URL: 'https://backend.lody.ai',
  CF_WORKER_URL: 'https://api.lody.ai',
};

// Local files are data, not shell scripts. Never evaluate substitutions or export secrets.
export function resolveBackendConfig(text = '', environment = process.env) {
  const file = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!match) throw new Error('Invalid mobile .env.local assignment');
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    file[match[1]] = value;
  }
  const result = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const raw = (environment[key] ?? file[key] ?? '').trim();
    const value = raw || fallback;
    if (!/^https:\/\/[^/?#@\\\s]+\/?$/.test(value))
      throw new Error(`Invalid ${key}: expected an HTTPS origin`);
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Invalid ${key}: expected an HTTPS origin`);
    }
    if (
      url.port === '0' ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['', '/'].includes(url.pathname)
    )
      throw new Error(`Invalid ${key}: expected an HTTPS origin without credentials or path`);
    result[key] = url.origin;
  }
  // Preserve existing production stores; every other endpoint tuple has its own namespace.
  result.STORAGE_SUFFIX = Object.entries(defaults).every(([key, value]) => result[key] === value)
    ? ''
    : '-' + createHash('sha256').update(JSON.stringify(result)).digest('hex').slice(0, 24);
  return result;
}

export function loadBackendConfig() {
  let text = '';
  try {
    text = readFileSync(new URL('.env.local', import.meta.url), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return resolveBackendConfig(text);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(loadBackendConfig()));
