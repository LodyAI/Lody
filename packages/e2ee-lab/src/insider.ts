import { Effect } from 'effect';
import { ContentCipher } from '@lody/e2ee-core';
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

const MARKER = new TextEncoder().encode('["lody-content/v1",');
const NONCE_TAG_SIGNATURE = 24 + 16 + 64;
const decoder = new TextDecoder('utf-8', { fatal: false });

/** Opens any well-signed frame: the insider ignores ledger authority entirely. */
const permissive = new ContentCipher({ authorize: (header) => header.device });

function markerPositions(bytes: Uint8Array): number[] {
  const hits: number[] = [];
  outer: for (let i = 2; i + MARKER.byteLength <= bytes.byteLength; i++) {
    for (let j = 0; j < MARKER.byteLength; j++) {
      if (bytes[i + j] !== MARKER[j]) continue outer;
    }
    hits.push(i);
  }
  return hits;
}

function headerAt(bytes: Uint8Array, at: number): { epoch: number; aadEnd: number } | null {
  const size = new DataView(bytes.buffer, bytes.byteOffset + at - 2, 2).getUint16(0);
  if (at + size > bytes.byteLength) return null;
  try {
    const fields = JSON.parse(decoder.decode(bytes.subarray(at, at + size))) as unknown;
    if (!Array.isArray(fields) || typeof fields[2] !== 'string') return null;
    const epoch = Number(fields[2]);
    return Number.isSafeInteger(epoch) ? { epoch, aadEnd: at + size } : null;
  } catch {
    return null;
  }
}

/**
 * Frames carry no total length and sit inside streams-crdt framing, so the
 * insider tries each end position up to the next header; the AEAD tag and
 * signature reject every wrong boundary.
 */
async function openAt(
  bytes: Uint8Array,
  at: number,
  limit: number,
  aadEnd: number,
  key: Uint8Array
): Promise<Uint8Array | null> {
  const header = JSON.parse(decoder.decode(bytes.subarray(at, aadEnd))) as string[];
  const scope = {
    genesis: header[1]!,
    epoch: Number(header[2]),
    resource: header[3]!,
    purpose: header[4] as 'doc-update',
  };
  for (let end = aadEnd + NONCE_TAG_SIGNATURE; end <= limit; end++) {
    try {
      const opened = await permissive.open(scope, key, bytes.subarray(at - 2, end));
      return opened.plaintext;
    } catch {
      /* wrong boundary or wrong key */
    }
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
): Effect.Effect<Uint8Array | null, never, LabHttp> {
  return Effect.gen(function* () {
    const http = yield* LabHttp;
    const base = `${riverrunUrl.replace(/\/$/, '')}/ds/${genesisHex}/${stream}`;
    const chunks: Uint8Array[] = [];
    let offset = '-1';
    for (let page = 0; page < 256; page++) {
      const response = yield* Effect.tryPromise(() =>
        http.fetch(`${base}?offset=${encodeURIComponent(offset)}`)
      ).pipe(Effect.catch(() => Effect.succeed(null)));
      // A stream that was never created is empty, not unreadable.
      if (response?.status === 404 && page === 0) return new Uint8Array();
      if (response?.status === 410 && page === 0) {
        // Compacted: the snapshot replaces the trimmed prefix.
        const compacted = yield* compactedStartEffect(base);
        if (!compacted) return null;
        if (compacted.snapshot) chunks.push(compacted.snapshot);
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
    return out;
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
      const hits = markerPositions(bytes);
      for (const [index, at] of hits.entries()) {
        const header = headerAt(bytes, at);
        if (!header) continue;
        const limit = (hits[index + 1] ?? bytes.byteLength + 2) - 2;
        const key = input.insider.epochKeys.get(header.epoch);
        const plaintext = key
          ? yield* Effect.promise(() => openAt(bytes, at, limit, header.aadEnd, key))
          : null;
        frames.push({
          stream,
          epoch: header.epoch,
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
