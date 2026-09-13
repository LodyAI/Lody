/**
 * B5: after a 10,000-record from-zero view, time extend(+1) and extend(+100).
 * Generation and the initial verify are not timed. Does not lower the 10k/100ms bar.
 */
import { cpus } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Ledger } from '../src/ledger';
import { buildChain, countSignatures, percentile } from './chain';

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

async function time(samples: number, warmup: number, run: () => Promise<void>): Promise<number[]> {
  for (let i = 0; i < warmup; i++) await run();
  const measured: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    await run();
    measured.push(performance.now() - start);
  }
  return measured;
}

async function main() {
  const count = Number.parseInt(arg('count', '10000'), 10);
  const extra = Number.parseInt(arg('extra', '100'), 10);
  const warmup = Number.parseInt(arg('warmup', '5'), 10);
  const samples = Number.parseInt(arg('samples', '30'), 10);
  const out = arg('out', '');
  if (!Number.isSafeInteger(count) || count < 2) throw new Error('invalid-count');
  if (!Number.isSafeInteger(extra) || extra < 1) throw new Error('invalid-extra');
  const total = count + extra;
  process.stderr.write(`building ${total} signed records\n`);
  const { created, records, ledger: expected } = await buildChain(total);
  const prefix = records.slice(0, count);
  const plus1 = records.slice(count, count + 1);
  const plusN = records.slice(count, count + extra);
  const bytes1 = plus1.reduce((sum, record) => sum + record.byteLength, 0);
  const bytesN = plusN.reduce((sum, record) => sum + record.byteLength, 0);
  const base = await Ledger.verify({ anchor: created.anchor, records: prefix });
  if (base.length !== count) throw new Error('base-length');
  const one = await base.extend(plus1);
  if (one.length !== count + 1) throw new Error('extend-1-length');
  const heapBefore = process.memoryUsage().heapUsed;
  const many = await base.extend(plusN);
  const heapAfterExtendN = process.memoryUsage().heapUsed;
  if (many.length !== count + extra) throw new Error('extend-n-length');
  if (many.head.some((byte, i) => byte !== expected.head[i])) throw new Error('extend-n-head');
  const fromZero1 = await Ledger.verify({
    anchor: created.anchor,
    records: records.slice(0, count + 1),
  });
  if (fromZero1.head.some((byte, i) => byte !== one.head[i])) throw new Error('from-zero-1');
  const fromZeroN = await Ledger.verify({
    anchor: created.anchor,
    records: records.slice(0, count + extra),
  });
  if (fromZeroN.head.some((byte, i) => byte !== many.head[i])) throw new Error('from-zero-n');
  const extend1 = await time(samples, warmup, async () => {
    const next = await base.extend(plus1);
    if (next.length !== count + 1) throw new Error('extend-1');
  });
  const extendN = await time(samples, warmup, async () => {
    const next = await base.extend(plusN);
    if (next.length !== count + extra) throw new Error('extend-n');
  });
  const sorted1 = [...extend1].sort((a, b) => a - b);
  const sortedN = [...extendN].sort((a, b) => a - b);
  const report = {
    env: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model ?? 'unknown',
    },
    load: {
      baseRecords: count,
      extra,
      extra1Bytes: bytes1,
      extraNBytes: bytesN,
      extra1Signatures: countSignatures(plus1),
      extraNSignatures: countSignatures(plusN),
      baseDevices: base.state.devices.size,
      baseMembers: base.state.members.size,
    },
    extend1: {
      samples: extend1,
      p50: percentile(sorted1, 50),
      p95: percentile(sorted1, 95),
      max: sorted1[sorted1.length - 1]!,
    },
    extendN: {
      samples: extendN,
      p50: percentile(sortedN, 50),
      p95: percentile(sortedN, 95),
      max: sortedN[sortedN.length - 1]!,
    },
    heapUsedDeltaBytes: heapAfterExtendN - heapBefore,
    fromZeroMatchesExtend: true,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(json);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
  }
}

await main();
