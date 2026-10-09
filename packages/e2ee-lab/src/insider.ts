import { Effect } from 'effect';
import { ContentCipher } from '@lody/e2ee-core';
import { streamsContentAdditionalData } from '@lody/e2ee-core/streams-content';
import { FLOCK_STREAM, LORO_STREAM } from './platform/protocol';
import { LabHttp, LiveLabHttp, runLabPromise } from './services';

/**
 * Key material a colluding insider legitimately held when it was excluded: its
 * own device's received epoch keys. Never another client's keys.
 */
export interface InsiderMaterial {
  readonly name: string;
  readonly epochKeys: ReadonlyMap<number, Uint8Array>;
}

export interface InsiderFrame {
  readonly stream: string;
  readonly epoch: number;
  readonly decrypted: boolean;
  /** UTF-8 (lossy) rendering of the opened payload; empty when not decrypted. */
  readonly text: string;
}

const decoder = new TextDecoder('utf-8', { fatal: false });
/** Attack-only: deliberately ignores ledger eligibility, never used by honest clients. */
const permissive = new ContentCipher({ authorize: (header) => header.device });
function contentFrames(
  bytes: Uint8Array,
  snapshot = false
): { epoch: number; kind: number; frame: Uint8Array; additionalData: Uint8Array }[] {
  const frames: { epoch: number; kind: number; frame: Uint8Array; additionalData: Uint8Array }[] =
    [];
  // LSCE occurs inside the SDK batch framing as well as standalone snapshots.
  for (let at = 0; at + 10 <= bytes.byteLength; at++) {
    if (
      bytes[at] !== 0x4c ||
      bytes[at + 1] !== 0x53 ||
      bytes[at + 2] !== 0x43 ||
      bytes[at + 3] !== 0x45 ||
      bytes[at + 4] !== 2
    )
      continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset + at, bytes.byteLength - at);
    const headerLength = view.getUint16(6);
    if (headerLength !== 1) continue;
    const start = at + 10 + headerLength;
    if (start + 141 > bytes.byteLength || bytes[start] !== 2) continue;
    // Update payloads use the SDK's u32be length framing. Snapshot HTTP bodies
    // have their own complete boundary; neither requires guessing ciphertext ends.
    if (!snapshot && at < 4) continue;
    const end = snapshot
      ? bytes.byteLength
      : at + new DataView(bytes.buffer, bytes.byteOffset + at - 4, 4).getUint32(0);
    if (end < start + 141 || end > bytes.byteLength) continue;
    frames.push({
      epoch: new DataView(bytes.buffer, bytes.byteOffset + start).getUint32(1),
      kind: bytes[at + 5]!,
      frame: bytes.subarray(start, end),
      additionalData: streamsContentAdditionalData(bytes.subarray(at, start)),
    });
    if (snapshot) break;
  }
  return frames;
}
async function openFrame(
  candidate: { epoch: number; kind: number; frame: Uint8Array; additionalData: Uint8Array },
  genesis: string,
  stream: string,
  key: Uint8Array
) {
  const scope = {
    genesis,
    epoch: candidate.epoch,
    resource: stream === FLOCK_STREAM ? 'flock' : 'loro',
    purpose: (stream === FLOCK_STREAM
      ? candidate.kind === 2
        ? 'flock-snapshot'
        : 'flock-update'
      : candidate.kind === 2
        ? 'doc-snapshot'
        : 'doc-update') as import('@lody/e2ee-core').ContentPurpose,
  };
  try {
    return (await permissive.open(scope, key, candidate.frame, candidate.additionalData)).plaintext;
  } catch {
    /* unavailable retained key, malformed frame or invalid signature */
  }
  return null;
}

function compactedStartEffect(
  base: string
): Effect.Effect<{ earliest: string; snapshot: Uint8Array | null } | null, never, LabHttp> {
  return Effect.gen(function* () {
    const http = yield* LabHttp;
    const head = yield* Effect.tryPromise(() => http.fetch(base, { method: 'HEAD' })).pipe(
      Effect.catch(() => Effect.succeed(null))
    );
    const earliest = head?.headers.get('stream-earliest-offset');
    if (!head?.ok || !earliest) return null;
    const at = head.headers.get('stream-snapshot-offset');
    if (!at || at === '-1') return { earliest, snapshot: null };
    const response = yield* Effect.tryPromise(() =>
      http.fetch(`${base}/snapshot/${encodeURIComponent(at)}`)
    ).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!response?.ok) return null;
    const snapshot = new Uint8Array(
      yield* Effect.tryPromise(() => response.arrayBuffer()).pipe(
        Effect.catch(() => Effect.succeed(new ArrayBuffer(0)))
      )
    );
    return { earliest, snapshot };
  });
}

function readStreamEffect(
  riverrunUrl: string,
  genesisHex: string,
  stream: string
): Effect.Effect<{ updates: Uint8Array; snapshot: Uint8Array | null } | null, never, LabHttp> {
  return Effect.gen(function* () {
    const http = yield* LabHttp;
    const base = `${riverrunUrl.replace(/\/$/, '')}/ds/${genesisHex}/${stream}`;
    const chunks: Uint8Array[] = [];
    let snapshot: Uint8Array | null = null;
    let offset = '-1';
    for (let page = 0; page < 256; page++) {
      const response = yield* Effect.tryPromise(() =>
        http.fetch(`${base}?offset=${encodeURIComponent(offset)}`)
      ).pipe(Effect.catch(() => Effect.succeed(null)));
      // A stream that was never created is empty, not unreadable.
      if (response?.status === 404 && page === 0)
        return { updates: new Uint8Array(), snapshot: null };
      if (response?.status === 410 && page === 0) {
        // Compacted: the snapshot replaces the trimmed prefix.
        const compacted = yield* compactedStartEffect(base);
        if (!compacted) return null;
        snapshot = compacted.snapshot;
        offset = compacted.earliest;
        continue;
      }
      if (!response?.ok) {
        if (process.env.E2EE_SCENARIO_DEBUG) {
          console.error(
            `[insider] ${stream} page ${page} status ${response?.status ?? 'fetch-error'}`
          );
        }
        return null;
      }
      const body = new Uint8Array(
        yield* Effect.tryPromise(() => response.arrayBuffer()).pipe(
          Effect.catch(() => Effect.succeed(new ArrayBuffer(0)))
        )
      );
      chunks.push(body);
      const next = response.headers.get('stream-next-offset') ?? offset;
      if (next === offset || body.byteLength === 0) break;
      offset = next;
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      out.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return { updates: out, snapshot };
  });
}

/**
 * What a colluding insider recovers from server-visible content: every frame on
 * the content streams, opened with the insider's retained keys and no
 * authorization check. Reads Riverrun directly, outside the scheduler. Null when
 * a stream could not be read (unmeasured, never an empty pass).
 */
export function insiderDecryptEffect(input: {
  riverrunUrl: string;
  genesisHex: string;
  insider: InsiderMaterial;
  streams?: readonly string[];
}): Effect.Effect<readonly InsiderFrame[] | null, never, LabHttp> {
  return Effect.gen(function* () {
    const frames: InsiderFrame[] = [];
    for (const stream of input.streams ?? [LORO_STREAM, FLOCK_STREAM]) {
      const bytes = yield* readStreamEffect(input.riverrunUrl, input.genesisHex, stream);
      if (bytes === null) return null;
      const candidates = [
        ...contentFrames(bytes.updates),
        ...(bytes.snapshot ? contentFrames(bytes.snapshot, true) : []),
      ];
      for (const candidate of candidates) {
        const key = input.insider.epochKeys.get(candidate.epoch);
        const plaintext = key
          ? yield* Effect.promise(() => openFrame(candidate, input.genesisHex, stream, key))
          : null;
        frames.push({
          stream,
          epoch: candidate.epoch,
          decrypted: plaintext !== null,
          text: plaintext ? decoder.decode(plaintext) : '',
        });
      }
    }
    return frames;
  });
}

export function insiderDecrypt(input: {
  riverrunUrl: string;
  genesisHex: string;
  insider: InsiderMaterial;
  streams?: readonly string[];
}): Promise<readonly InsiderFrame[] | null> {
  return runLabPromise(insiderDecryptEffect(input), LiveLabHttp);
}
