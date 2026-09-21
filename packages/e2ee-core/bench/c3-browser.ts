/**
 * C3 desktop Chromium smoke: public Ledger.verify/extend plus recovery-file
 * open in a real browser. Serves on localhost so WebAuthn RP ID is valid.
 * WebAuthn/PRF is probed and recorded as unsupported when no authenticator
 * or PRF extension is present. Not a mobile or Passkey pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../src/ledger';
import { createRecoveryFile, sealRecoveryBackup } from '../src/recovery-file';
import { admitDeviceOp, append, ed25519, hex, random, signGenesis } from '../test/ledger-fixtures';

const here = dirname(fileURLToPath(import.meta.url));

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function findEsbuild(): string {
  const pnpm = join(here, '../../../node_modules/.pnpm');
  for (const name of readdirSync(pnpm)) {
    if (!name.startsWith('esbuild@')) continue;
    const bin = join(pnpm, name, 'node_modules/esbuild/bin/esbuild');
    if (existsSync(bin)) return bin;
  }
  throw new Error('esbuild-not-found');
}

function bundle(): string {
  const entry = join(here, 'c3-browser-entry.ts');
  const outfile = join(mkdtempSync(join(tmpdir(), 'lody-e2ee-c3-bundle-')), 'bundle.js');
  const result = spawnSync(
    findEsbuild(),
    [
      entry,
      '--bundle',
      '--format=iife',
      '--platform=browser',
      '--external:node:os',
      '--external:node:url',
      '--external:node:worker_threads',
      `--outfile=${outfile}`,
    ],
    { cwd: join(here, '..'), encoding: 'utf8' }
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'esbuild-failed\n');
    throw new Error('esbuild-failed');
  }
  return outfile;
}

async function main() {
  const out = arg('out', '');
  const chromium = arg('chromium', '/opt/homebrew/bin/chromium');
  const host = arg('host', 'localhost');
  const headed = process.argv.includes('--headed');
  const owner = await ed25519();
  const secret = random(32);
  const created = await signGenesis(owner, secret);
  const phone = await ed25519();
  const admitted = await append(
    created.ledger,
    owner,
    await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', true)
  );
  const extraDevice = await ed25519();
  const extra = await append(
    admitted.ledger,
    owner,
    await admitDeviceOp(created.anchor, created.membershipId, extraDevice, 'personal', false)
  );
  const check = await Ledger.verify({
    anchor: created.anchor,
    records: [created.record, admitted.record],
  });
  if (check.length !== 2) throw new Error('fixture-verify');
  const identity = hex(created.anchor);
  const recoveryFile = createRecoveryFile();
  const recoveryBackup = sealRecoveryBackup(recoveryFile, { identity, revision: 1 }, secret);
  const fixture = JSON.stringify({
    anchor: hex(created.anchor),
    records: [hex(created.record), hex(admitted.record)],
    extra: hex(extra.record),
    recoveryFile: hex(recoveryFile),
    recoveryBackup: hex(recoveryBackup),
    identity,
    epochKey: hex(secret),
  });
  const html = readFileSync(join(here, 'c3-browser.html'));
  const js = readFileSync(bundle());
  let resolveResult!: (value: string) => void;
  const result = new Promise<string>((resolve) => {
    resolveResult = resolve;
  });
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'POST' && path === '/result') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk as Buffer));
      request.on('end', () => {
        response.writeHead(204).end();
        resolveResult(Buffer.concat(chunks).toString('utf8'));
      });
      return;
    }
    if (path === '/' || path === '/index.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      return;
    }
    if (path === '/bundle.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(js);
      return;
    }
    if (path === '/fixture.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(fixture);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen-failed');
  const url = `http://${host}:${address.port}/`;
  process.stderr.write(`serving ${url}\n`);
  const profile = mkdtempSync(join(tmpdir(), 'lody-e2ee-c3-chromium-'));
  const chromeArgs = [
    ...(headed ? [] : ['--headless', '--disable-gpu']),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    `--user-data-dir=${profile}`,
    `--crash-dumps-dir=${profile}`,
    '--remote-debugging-port=0',
    url,
  ];
  const child = spawn(chromium, chromeArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', (chunk) => process.stderr.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const body = await Promise.race([
    result,
    new Promise<string>((_, reject) => {
      child.on('exit', (code) => reject(new Error(`chromium-exit-${code}`)));
      setTimeout(() => reject(new Error('chromium-timeout')), 60_000);
    }),
  ]);
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  child.unref();
  server.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Chromium may keep the profile dir. */
  }
  const parsed = JSON.parse(body) as { error?: string };
  if (parsed.error) throw new Error(parsed.error);
  const json = `${JSON.stringify(JSON.parse(body), null, 2)}\n`;
  process.stdout.write(json);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
  }
}

await main();
