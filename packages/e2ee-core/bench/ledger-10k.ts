import { cpus } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Ledger } from '../src/ledger';
import { buildChain, countSignatures, percentile } from './chain';

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

async function main() {
  const count = Number.parseInt(arg('count', '10000'), 10);
  const warmup = Number.parseInt(arg('warmup', '5'), 10);
  const samples = Number.parseInt(arg('samples', '30'), 10);
  const out = arg('out', '');
  if (!Number.isSafeInteger(count) || count < 2) throw new Error('invalid-count');
  process.stderr.write(`building ${count} signed records\n`);
  const { created, records, ledger: expected } = await buildChain(count);
  if (records.length !== count) throw new Error('short-chain');
  const bytes = records.reduce((sum, record) => sum + record.byteLength, 0);
  const signatures = countSignatures(records);
  const check = await Ledger.verify({ anchor: created.anchor, records });
  if (check.length !== expected.length || check.head.some((byte, i) => byte !== expected.head[i])) {
    throw new Error('fixture-mismatch');
  }
  const run = async () => {
    const start = performance.now();
    const verified = await Ledger.verify({ anchor: created.anchor, records });
    const ms = performance.now() - start;
    if (verified.length !== count) throw new Error('verify-length');
    if (verified.head.some((byte, i) => byte !== expected.head[i])) throw new Error('verify-head');
    return ms;
  };
  const warm: number[] = [];
  for (let i = 0; i < warmup; i++) warm.push(await run());
  const measured: number[] = [];
  for (let i = 0; i < samples; i++) measured.push(await run());
  const sorted = [...measured].sort((a, b) => a - b);
  const report = {
    env: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model ?? 'unknown',
      cwd: process.cwd(),
    },
    load: {
      records: count,
      bytes,
      signatures,
      head: Buffer.from(expected.head).toString('hex'),
      epoch: expected.state.epoch.number,
      members: expected.state.members.size,
      devices: expected.state.devices.size,
    },
    warmup: warm,
    samples: measured,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1]!,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(json);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
  }
}

await main();
