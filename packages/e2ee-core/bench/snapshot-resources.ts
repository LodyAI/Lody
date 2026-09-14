/**
 * S5 resource probe: snapshot size and bootstrap vs full-audit time.
 * Not a millisecond gate. Confirms the join path does not full-replay prefix hashes.
 */
import { Ledger } from '@lody/e2ee-core';
import { buildMixedChain, ed25519 } from '../test/ledger-fixtures';

const count = Number(process.argv[2] ?? 256);
const built = await buildMixedChain(count);
const owner = built.owner;
const records = built.records;
const suffix = records.slice(-8);
const prefix = records.slice(0, records.length - suffix.length);
const atSnap = await Ledger.verify({
  anchor: built.created.anchor,
  records: prefix,
});
const proposal = atSnap.prepareSnapshot(owner.publicKey);
const snapshot = await Ledger.finalizeSnapshot(proposal, await owner.sign(proposal.signingBytes));
const trust = {
  genesis: proposal.genesis,
  endorser: owner.publicKey,
  head: proposal.head,
  headSignature: await owner.sign(proposal.headAttestationSigningBytes),
};

const snapStart = performance.now();
const joined = await Ledger.verifySnapshot({ trust, snapshot, suffix });
const snapMs = performance.now() - snapStart;
const fullStart = performance.now();
const audited = await Ledger.verify({ anchor: built.created.anchor, records });
const fullMs = performance.now() - fullStart;

let prefixHashUnavailable = false;
try {
  joined.hashAt(1);
} catch {
  prefixHashUnavailable = true;
}

const peer = await ed25519();
const extra = await ed25519();
const cmp = Ledger.compareNotes(
  joined.comparisonNote(peer.publicKey),
  audited.comparisonNote(extra.publicKey),
  { originalEndorser: owner.publicKey }
);

const report = {
  records: records.length,
  snapshotBytes: snapshot.byteLength,
  suffixRecords: suffix.length,
  snapshotMs: Math.round(snapMs * 1000) / 1000,
  fullAuditMs: Math.round(fullMs * 1000) / 1000,
  origin: joined.origin,
  prefixHashUnavailable,
  silentFullReplay: joined.origin !== 'snapshot' || !prefixHashUnavailable,
  compare: cmp.kind,
  lengthMatch: joined.length === audited.length,
  headMatch: Buffer.from(joined.head).equals(Buffer.from(audited.head)),
};
if (report.silentFullReplay) throw new Error('silent-full-replay');
if (!report.lengthMatch || !report.headMatch || cmp.kind !== 'agree') {
  throw new Error('snapshot-mismatch');
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
