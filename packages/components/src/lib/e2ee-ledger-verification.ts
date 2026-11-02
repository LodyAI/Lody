import { Bytes, hasVerifiedCheckpoint, ledgerStateDigest } from '@lody/e2ee-core/protocol';
import { Result } from 'effect';
import { bytesToHex, type VerifiedLedgerHistory } from './e2ee-ledger-history';

/**
 * Out-of-band ledger comparison, like a messenger's safety number. The state
 * digest binds the protocol, genesis, version, head and the actual permission
 * state (members, roles, devices, public keys, epoch), so two people who read
 * the same digest hold the same ledger at that version. It proves nothing
 * about later records or about who a person is.
 */
export interface LedgerVerificationCode {
  /** Number of verified records; the ledger "version" this code describes. */
  version: number;
  /** Lowercase hex hash of the last verified record. */
  headHash: string;
  /** Lowercase hex comparison digest, the same digest core comparison notes carry. */
  stateDigest: string;
  /** What the QR code carries. */
  payload: string;
}

const PAYLOAD = /lody-ledger:1:(\d{1,9}):([0-9a-f]{64}):([0-9a-f]{64})(?![0-9a-f])/;
const VERSION = /(?:版本|version)\s*(\d{1,9})/;

export function ledgerVerificationCode(history: VerifiedLedgerHistory): LedgerVerificationCode {
  const version = history.view.length;
  const headHash = bytesToHex(history.view.head.toBytes());
  const stateDigest = bytesToHex(Result.getOrThrow(ledgerStateDigest(history.view)).toBytes());
  return {
    version,
    headHash,
    stateDigest,
    payload: `lody-ledger:1:${version}:${headHash}:${stateDigest}`,
  };
}

/** Sixteen groups of four: easy to read aloud and compare line by line. */
export const groupHash = (hash: string): string[] => hash.match(/.{4}/g) ?? [];

export interface ScannedCode {
  /** From a QR payload, or from the version in a copied code's header. */
  version?: number;
  /** Only a QR payload carries the head. */
  headHash?: string;
  stateDigest: string;
}

/**
 * Accepts a QR payload anywhere in the text, or a pasted digest: one 64-digit
 * run or sixteen groups of four separated by anything that is not a hex digit.
 * A run longer than sixteen groups keeps its last sixteen, so a version number
 * written just before the digest is not mistaken for part of it.
 */
export function parseVerificationCode(text: string): ScannedCode | null {
  const lower = text.toLowerCase();
  const payload = PAYLOAD.exec(lower);
  if (payload)
    return { version: Number(payload[1]), headHash: payload[2], stateDigest: payload[3] };
  const versionMatch = VERSION.exec(lower);
  const version = versionMatch ? Number(versionMatch[1]) : undefined;
  const withVersion = (stateDigest: string): ScannedCode =>
    version === undefined ? { stateDigest } : { version, stateDigest };
  const tokens = lower.split(/[^0-9a-f]+/).filter((token) => token.length > 0);
  const whole = tokens.find((token) => token.length === 64);
  if (whole !== undefined) return withVersion(whole);
  let run: string[] = [];
  for (const token of [...tokens, '']) {
    if (token.length === 4) {
      run.push(token);
      continue;
    }
    if (run.length >= 16) return withVersion(run.slice(-16).join(''));
    run = [];
  }
  return null;
}

export type VerificationResult =
  | { kind: 'match'; version: number }
  /**
   * Their version is earlier. `prefixConfirmed` when their head is this
   * ledger's record at that version, so the shared history is identical.
   */
  | { kind: 'theirs-older'; version: number; prefixConfirmed: boolean }
  /** Their code claims a later version this device has not verified yet. */
  | { kind: 'theirs-newer'; version: number }
  /** A different digest with no version to tell "newer" from "different". */
  | { kind: 'unknown' }
  /** Same version, or a shared earlier record, that differs: the ledgers differ. */
  | { kind: 'mismatch' };

export function compareVerificationCode(
  history: VerifiedLedgerHistory,
  scanned: ScannedCode
): VerificationResult {
  const mine = ledgerVerificationCode(history);
  const { version } = scanned;
  if (version === undefined)
    return scanned.stateDigest === mine.stateDigest
      ? { kind: 'match', version: mine.version }
      : { kind: 'unknown' };
  if (version > mine.version) return { kind: 'theirs-newer', version };
  if (version === mine.version)
    return scanned.stateDigest === mine.stateDigest &&
      (scanned.headHash === undefined || scanned.headHash === mine.headHash)
      ? { kind: 'match', version }
      : { kind: 'mismatch' };
  if (scanned.headHash === undefined)
    return { kind: 'theirs-older', version, prefixConfirmed: false };
  const known = history.records.find((record) => record.index === version - 1);
  if (known)
    return known.hash === scanned.headHash
      ? { kind: 'theirs-older', version, prefixConfirmed: true }
      : { kind: 'mismatch' };
  if (version - 1 < history.view.historyStart)
    return { kind: 'theirs-older', version, prefixConfirmed: false };
  const head = Bytes.recordHash(
    Uint8Array.from(scanned.headHash.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
  );
  return Result.isSuccess(head) &&
    Result.getOrThrow(hasVerifiedCheckpoint(history.view, { head: head.success, length: version }))
    ? { kind: 'theirs-older', version, prefixConfirmed: true }
    : { kind: 'mismatch' };
}
