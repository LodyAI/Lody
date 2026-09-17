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

export function prefixedEntropy(prefix: string, inner: Entropy): Entropy {
  return {
    fill(label, bytes) {
      return inner.fill(`${prefix}:${label}`, bytes);
    },
  };
}
