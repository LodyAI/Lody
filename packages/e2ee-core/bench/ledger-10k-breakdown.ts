/**
 * Same 10k from-zero load as bench/ledger-10k.ts, plus a decode/hash/sig
 * breakdown. Official bar is still full Ledger.verify; this does not omit
 * signatures or use snapshots.
 */
import { writeFileSync } from 'node:fs';
import { Ledger } from '../src/ledger';
import { hashRecordBytes, recordSigningBytes, verifySignature } from '../src/ledger/crypto';
import { decodeRecord } from '../src/ledger/schema';
import { buildChain, countSignatures } from './chain';

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

async function timed(label: string, fn: () => Promise<unknown> | unknown): Promise<number> {
  const start = performance.now();
  await fn();
  const ms = performance.now() - start;
  process.stderr.write(`${label}: ${ms.toFixed(1)}ms\n`);
  return ms;
}

async function main() {
  const count = Number.parseInt(arg('count', '10000'), 10);
  const out = arg('out', '');
  process.stderr.write(`building ${count}\n`);
  const { created, records, ledger: expected } = await buildChain(count);
  const signatures = countSignatures(records);
  const bytes = records.reduce((sum, record) => sum + record.byteLength, 0);
  await Ledger.verify({ anchor: created.anchor, records });
  const full1 = await timed('full-verify-1', () =>
    Ledger.verify({ anchor: created.anchor, records })
  );
  const full2 = await timed('full-verify-2', () =>
    Ledger.verify({ anchor: created.anchor, records })
  );
  const decodeMs = await timed('decode-all', () => records.map((record) => decodeRecord(record)));
  const decoded = records.map((record) => decodeRecord(record));
  const hashMs = await timed('hash-all', () => {
    for (const record of records) hashRecordBytes(record);
  });
  const outerMs = await timed('outer-sigs', () => {
    for (const record of decoded) {
      if (
        !verifySignature(
          record.body.fields.signer,
          recordSigningBytes(record.bodyBytes),
          record.signature
        )
      ) {
        throw new Error('outer-bad');
      }
    }
  });
  const report = {
    load: { records: count, bytes, signatures, head: Buffer.from(expected.head).toString('hex') },
    fullVerifyMs: [full1, full2],
    decodeAllMs: decodeMs,
    hashAllMs: hashMs,
    outerSigsMs: outerMs,
    remainderHintMs: full2 - decodeMs - hashMs - outerMs,
    note: 'remainder includes nested proofs + policy replay + worker spawn; bar is fullVerifyMs, not lowered',
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(json);
  if (out) writeFileSync(out, json);
}

await main();
