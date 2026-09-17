import { createHash } from 'node:crypto';
import { liveEntropy, type Entropy } from '@lody/e2ee-core';

export interface EntropyFill {
  readonly label: string;
  readonly bytes: Uint8Array;
}

/** Public scenario seed is not mixed into cryptographic bits. */
export type PublicScenarioSeed = string;

export type RecordingEntropy = Entropy & { fills: EntropyFill[] };

export function isRecordingEntropy(value: Entropy): value is RecordingEntropy {
  return 'fills' in value;
}

export function recordingEntropy(inner: Entropy = liveEntropy): RecordingEntropy {
  const fills: EntropyFill[] = [];
  return {
    fills,
    fill(label, bytes) {
      inner.fill(label, bytes);
      fills.push({ label, bytes: new Uint8Array(bytes) });
      return bytes;
    },
  };
}

export function replayEntropy(script: readonly EntropyFill[]): Entropy {
  const remaining = script.map((fill) => ({
    label: fill.label,
    bytes: new Uint8Array(fill.bytes),
  }));
  return {
    fill(label, bytes) {
      const next = remaining.shift();
      if (!next || next.label !== label || next.bytes.byteLength !== bytes.byteLength) {
        throw new Error(
          `entropy-mismatch:${label}:${bytes.byteLength}:got:${next?.label}:${next?.bytes.byteLength}`
        );
      }
      bytes.set(next.bytes);
      return bytes;
    },
  };
}

/**
 * Test-only deterministic entropy for subprocesses that cannot report fills
 * back (e.g. SIGKILLed crash clients). The seed is private replay material.
 */
export function seededEntropy(seed: Uint8Array): Entropy {
  const seen = new Map<string, number>();
  return {
    fill(label, bytes) {
      const index = seen.get(label) ?? 0;
      seen.set(label, index + 1);
      let offset = 0;
      let block = 0;
      while (offset < bytes.byteLength) {
        const digest = createHash('sha256')
          .update(seed)
          .update(label)
          .update(String(index))
          .update(String(bytes.byteLength))
          .update(String(block))
          .digest();
        block += 1;
        const take = Math.min(digest.byteLength, bytes.byteLength - offset);
        bytes.set(digest.subarray(0, take), offset);
        offset += take;
      }
      return bytes;
    },
  };
}

export function prefixedEntropy(prefix: string, inner: Entropy): Entropy {
  return {
    fill(label, bytes) {
      return inner.fill(`${prefix}:${label}`, bytes);
    },
  };
}
