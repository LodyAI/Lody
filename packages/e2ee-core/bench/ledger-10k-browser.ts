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
import { buildChain, countSignatures } from './chain';

const here = dirname(fileURLToPath(import.meta.url));

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function encodeFixture(input: {
  count: number;
  warmup: number;
  samples: number;
  signatures: number;
  epoch: number;
  members: number;
  devices: number;
  anchor: Uint8Array;
  head: Uint8Array;
  records: readonly Uint8Array[];
}): Uint8Array {
  const body = input.records.reduce((sum, record) => sum + 4 + record.byteLength, 0);
  const out = new Uint8Array(96 + body);
  out.set(Buffer.from('E2EE'), 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, input.count, false);
  view.setUint32(8, input.warmup, false);
  view.setUint32(12, input.samples, false);
  view.setUint32(16, input.signatures, false);
  view.setUint32(20, input.epoch, false);
  view.setUint32(24, input.members, false);
  view.setUint32(28, input.devices, false);
  out.set(input.anchor, 32);
  out.set(input.head, 64);
  let offset = 96;
  for (const record of input.records) {
    view.setUint32(offset, record.byteLength, false);
    offset += 4;
    out.set(record, offset);
    offset += record.byteLength;
  }
  return out;
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
  const entry = join(here, 'ledger-10k-browser-entry.ts');
  const outfile = join(mkdtempSync(join(tmpdir(), 'lody-e2ee-bundle-')), 'bundle.js');
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
  const count = Number.parseInt(arg('count', '10000'), 10);
  const warmup = Number.parseInt(arg('warmup', '5'), 10);
  const samples = Number.parseInt(arg('samples', '30'), 10);
  const out = arg('out', '');
  const chromium = arg('chromium', '/opt/homebrew/bin/chromium');
  if (!Number.isSafeInteger(count) || count < 2) throw new Error('invalid-count');
  process.stderr.write(`building ${count} signed records\n`);
  const { created, records, ledger: expected } = await buildChain(count);
  const check = await Ledger.verify({ anchor: created.anchor, records });
  if (check.length !== expected.length || check.head.some((byte, i) => byte !== expected.head[i])) {
    throw new Error('fixture-mismatch');
  }
  const fixture = encodeFixture({
    count,
    warmup,
    samples,
    signatures: countSignatures(records),
    epoch: expected.state.epoch.number,
    members: expected.state.members.size,
    devices: expected.state.devices.size,
    anchor: created.anchor,
    head: expected.head,
    records,
  });
  const html = readFileSync(join(here, 'ledger-10k-browser.html'));
  const js = readFileSync(bundle());
  const progressPath = out ? `${out}.progress.jsonl` : '';
  if (progressPath) mkdirSync(dirname(progressPath), { recursive: true });
  let resolveResult!: (value: string) => void;
  const result = new Promise<string>((resolve) => {
    resolveResult = resolve;
  });
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'POST' && path === '/progress') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk as Buffer));
      request.on('end', () => {
        const line = Buffer.concat(chunks).toString('utf8');
        process.stderr.write(`${line}\n`);
        if (progressPath) writeFileSync(progressPath, `${line}\n`, { flag: 'a' });
        response.writeHead(204).end();
      });
      return;
    }
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
    if (path === '/fixture.bin') {
      response
        .writeHead(200, { 'Content-Type': 'application/octet-stream' })
        .end(Buffer.from(fixture));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen-failed');
  const url = `http://127.0.0.1:${address.port}/`;
  process.stderr.write(`serving ${url}\n`);
  const profile = mkdtempSync(join(tmpdir(), 'lody-e2ee-chromium-'));
  const child = spawn(
    chromium,
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-crash-reporter',
      `--user-data-dir=${profile}`,
      `--crash-dumps-dir=${profile}`,
      '--remote-debugging-port=0',
      url,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true }
  );
  child.stdout.on('data', (chunk) => process.stderr.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const timeoutMs = Math.max(600_000, (warmup + samples) * Math.max(180_000, count * 40));
  const body = await Promise.race([
    result,
    new Promise<string>((_, reject) => {
      child.on('exit', (code) => reject(new Error(`chromium-exit-${code}`)));
      setTimeout(() => reject(new Error('chromium-timeout')), timeoutMs);
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
    /* Chromium may keep the profile dir; not part of the measurement. */
  }
  const parsed = JSON.parse(body) as { error?: string };
  if (parsed.error) throw new Error(parsed.error);
  const json = `${JSON.stringify(JSON.parse(body), null, 2)}\n`;
  process.stdout.write(json);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
  }
  process.exit(0);
}

await main();
