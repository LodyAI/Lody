import { z } from 'zod';
import type { TransportRoomStatus } from 'loro-repo';

// Protocol 7: peer-scoped push channel with version-vector deltas and local
// presence / machine-monitor state exchange.
//
// v7 hard-cuts v6 by REMOVING the single-author write-intent envelope
// (`intent` / `intent-ack`, v4–v6). Under the dual-author architecture
// (specs/local-first-two-plane.md) the renderer direct-authors its own durable
// writes and uploads them over its own cloud connection; the local plane is
// pure CRDT sync plus ephemeral push, so authored user writes no longer cross
// this socket as commands.
//
// **Sync model (2026-07-06 rewrite):** doc rooms AND flock rooms sync via
// per-peer version-vector deltas. Flock (@loro-dev/flock >= 4) has
// `exportJson(from)` / `version()`, so the earlier "flock rooms sync via full
// bundles" design (based on a stale no-delta-API assumption) is gone:
// `haveVersion`/`serverVersion` carry a JSON-encoded flock version vector for
// flock rooms (base64 Loro VV for doc rooms), and every flock payload is an
// incremental bundle. Flock entries are self-contained LWW records (each
// carries its own clock), so a delta bundle is independently importable — an
// oversized flock delta is CHUNKED into multiple frames instead of failing the
// room.
//
// The v2 → v3 changes that still hold:
//
// v3 hard-cuts v2 (no back-compat; renderer and daemon ship together — the
// `protocolVersion` literal in every schema rejects a mismatched peer at parse
// time). The v2 → v3 changes, driven by the 2026-07-04 review:
//
// - **Peer-scoped addressing.** Every adapter instance has a unique `peerId`.
//   Every message in both directions carries `workspaceId` + `peerId` (server →
//   client messages name their TARGET peer; `presence` is a workspace-level
//   broadcast and carries `workspaceId` only). The Electron relay stays a dumb
//   broadcast pipe: correctness lives here — adapters drop frames whose
//   workspaceId/peerId is not theirs, and servers keep per-peer sync state.
//   (Review F1/F2/F3: connection-keyed subscriber state starved sibling
//   windows, `joined` responses collided across adapters, and meta rooms
//   leaked across workspaces.)
// - **Peer lifecycle.** `leave` withdraws one room; `detach` withdraws a whole
//   peer (adapter close, or synthesized by the Electron relay when a renderer
//   window is destroyed/navigates). (Review F8.)
// - **Join = reconciliation point.** `joined` returns the server's version so
//   the client can up-sync any ops the server is missing; correctness never
//   depends on the client's in-memory dirty flag. (Review F5.)
// - **Connection liveness.** `ping`/`pong` are connection-scoped (no
//   workspace/peer) and back the mandatory idle watchdog on the relay ↔ daemon
//   socket. (Review F4 / plan §Effect 使用.)
// - **Frame discipline.** Senders never write a frame larger than
//   `LOCAL_LORO_DATA_PLANE_MAX_FRAME_BYTES`. An oversized FLOCK delta is
//   chunked entry-wise (every entry is independently importable). An oversized
//   DOC delta is chunked at the TRANSPORT layer (2026-07-24, same protocol
//   version — both ends ship together): a Loro update blob is causally
//   dependent, so the base64 payload is sliced into `doc-update-chunk` frames
//   and reassembled by the receiver before ONE import. This replaced the
//   former terminal `payload_too_large` failure for doc rooms (a big session
//   doc's first catch-up export is a realistic oversize; a permanently dead
//   room is not an acceptable answer to it). `payload_too_large` remains
//   terminal only for the pathological single-flock-entry-over-budget case,
//   where retrying is deterministic (R4: 终态错误而非死循环). The
//   receiver-side splitter cap is defense-in-depth only and must never tear
//   down the connection. (Review F6.)
export const LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION = 7;

/**
 * Hard upper bound for one newline-delimited frame on the local data-plane
 * socket. Receivers size their splitter buffers with this.
 */
export const LOCAL_LORO_DATA_PLANE_MAX_FRAME_BYTES = 32 * 1024 * 1024;

/**
 * Sender-side budget for a sync payload (base64 doc update / flock bundle
 * JSON). Leaves headroom under the frame bound for the message envelope, so a
 * compliant sender can never trip a compliant receiver's frame cap.
 */
export const LOCAL_LORO_DATA_PLANE_MAX_PAYLOAD_BYTES =
  LOCAL_LORO_DATA_PLANE_MAX_FRAME_BYTES - 64 * 1024;

/**
 * Terminal room error code for a sync payload that exceeds the frame budget.
 * Since doc-update chunking landed this is reachable only for the pathological
 * single-flock-entry-over-budget case (nothing smaller than one record can be
 * framed, so retrying is deterministic).
 */
export const LOCAL_LORO_DATA_PLANE_PAYLOAD_TOO_LARGE = 'payload_too_large';

// Schemas are intentionally not `.strict()`: the envelope crosses the
// renderer↔daemon boundary, so a peer adding a forward-compatible field must
// still validate for an older reader. `protocolVersion` is the explicit gate for
// genuinely incompatible revisions.
const LocalLoroDataPlaneRoomSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('meta') }),
  z.object({ scope: z.literal('doc'), docId: z.string().min(1) }),
  z.object({ scope: z.literal('flock-doc'), flockDocId: z.string().min(1) }),
]);

// A `doc-update` carries a Loro update export (delta from the receiver's version
// vector, or a from-empty export for a first sync). A `flock-json` carries an
// incremental Flock JSON bundle (`exportJson(from)` — entries newer than the
// receiver's flock version vector; a from-empty export for a first sync). Flock
// entries are self-contained LWW records, so every bundle — including one chunk
// of a split oversized delta — is independently importable.
const LocalLoroDocPayloadSchema = z.object({
  kind: z.literal('doc-update'),
  dataBase64: z.string().min(1),
});

// One slice of an oversized doc update. A Loro update blob is causally
// dependent — unlike flock entries the pieces are NOT independently
// importable — so chunking happens at the transport layer: the base64 payload
// is sliced byte-wise and the receiver reassembles the full string before ONE
// import. Chunks of a transfer travel in order on the same connection;
// `transferId` pins the transfer so a receiver can discard a stale partial
// (rejoin, superseding upload) instead of concatenating across transfers.
const LocalLoroDocChunkPayloadSchema = z.object({
  kind: z.literal('doc-update-chunk'),
  transferId: z.string().min(1),
  chunkIndex: z.number().int().nonnegative(),
  chunkCount: z.number().int().positive(),
  dataBase64: z.string().min(1),
});

const LocalLoroFlockPayloadSchema = z.object({
  kind: z.literal('flock-json'),
  bundle: z.unknown(),
});

export const LocalLoroDataPlanePayloadSchema = z.discriminatedUnion('kind', [
  LocalLoroDocPayloadSchema,
  LocalLoroDocChunkPayloadSchema,
  LocalLoroFlockPayloadSchema,
]);

// ---- Client → server messages ----

const LocalLoroJoinMessageSchema = z.object({
  type: z.literal('join'),
  protocolVersion: z.literal(LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION),
  requestId: z.string().min(1),
  workspaceId: z.string().min(1),
  peerId: z.string().min(1),
  room: LocalLoroDataPlaneRoomSchema,
  // What the client already has: a base64 Loro version vector for doc rooms, a
  // JSON-encoded flock version vector (`encodeFlockVersion`) for flock rooms.
  // Absent for a brand-new/empty client (server exports from empty).
  haveVersion: z.string().optional(),
});

const LocalLoroUpdateMessageSchema = z.object({
  type: z.literal('update'),
  protocolVersion: z.literal(LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION),
  workspaceId: z.string().min(1),
  peerId: z.string().min(1),
  room: LocalLoroDataPlaneRoomSchema,
  haveVersion: z.string().optional(),
  payload: LocalLoroDataPlanePayloadSchema,
});

const LocalLoroLeaveMessageSchema = z.object({
  type: z.literal('leave'),
  protocolVersion: z.literal(LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION),
  workspaceId: z.string().min(1),
  peerId: z.string().min(1),
  room: LocalLoroDataPlaneRoomSchema,
});

// The peer is going away entirely (adapter close / renderer window destroyed or
// navigated — the Electron relay synthesizes this for dead windows). The server
// drops every subscription held by this peer.
const LocalLoroDetachMessageSchema = z.object({
  type: z.literal('detach'),
  protocolVersion: z.literal(LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION),
  workspaceId: z.string().min(1),
  peerId: z.string().min(1),
});

// Bidirectional local machine-monitor state. The renderer sends its observer
// EphemeralStore bundle; the CLI replies with the merged observer/snapshot store.
// This keeps local device sampling independent from the cloud remote bridge.
const LocalLoroMachineMonitorMessageSchema = z.object({
  type: z.literal('machine-monitor'),
  protocolVersion: z.literal(LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION),
  workspaceId: z.string().min(1),
  peerId: z.string().min(1),
  dataBase64: z.string().min(1),
});

// Connection-scoped liveness probe (relay → daemon). Deliberately carries no
// workspaceId/peerId: it belongs to the socket, not to any peer.
const LocalLoroPingMessageSchema = z.object({
  type: z.literal('ping'),
  protocolVersion: z.literal(LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION),
});

export const LocalLoroDataPlaneClientMessageSchema = z.discriminatedUnion('type', [
  LocalLoroJoinMessageSchema,
  LocalLoroUpdateMessageSchema,
  LocalLoroLeaveMessageSchema,
  LocalLoroDetachMessageSchema,
  LocalLoroMachineMonitorMessageSchema,
  LocalLoroPingMessageSchema,
]);

// ---- Server → client messages ----

const LocalLoroJoinedMessageSchema = z.object({
  type: z.literal('joined'),
  protocolVersion: z.literal(LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION),
  workspaceId: z.string().min(1),
  // Target peer: only the adapter that issued this join may consume it.
  peerId: z.string().min(1),
  requestId: z.string().min(1),
  room: LocalLoroDataPlaneRoomSchema,
  // Server's version vector after this response (base64 Loro VV for doc rooms,
  // JSON flock VV for flock rooms); the client exports its up-sync deltas from
  // here.
  serverVersion: z.string().optional(),
  // Down-sync delta the client was missing; absent when the client is already
  // up to date.
  payload: LocalLoroDataPlanePayloadSchema.optional(),
});

const LocalLoroServerUpdateMessageSchema = z.object({
  type: z.literal('update'),
  protocolVersion: z.literal(LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION),
  workspaceId: z.string().min(1),
  // Target peer: deltas are exported per peer (from that peer's lastSentVV), so
  // updates are always addressed, never ambient.
  peerId: z.string().min(1),
  room: LocalLoroDataPlaneRoomSchema,
  serverVersion: z.string().optional(),
  payload: LocalLoroDataPlanePayloadSchema,
});

const LocalLoroServerRoomStatusMessageSchema = z.object({
  type: z.literal('room-status'),
  protocolVersion: z.literal(LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION),
  workspaceId: z.string().min(1),
  peerId: z.string().min(1),
  room: LocalLoroDataPlaneRoomSchema,
  status: z.enum(['connecting', 'joined', 'reconnecting', 'disconnected', 'error']),
});

const LocalLoroServerErrorMessageSchema = z.object({
  type: z.literal('error'),
  protocolVersion: z.literal(LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION),
  workspaceId: z.string().optional(),
  // Target peer, echoed from the offending client message when known.
  peerId: z.string().optional(),
  requestId: z.string().optional(),
  // Room-scoped errors let the client degrade one room instead of the channel.
  room: LocalLoroDataPlaneRoomSchema.optional(),
  code: z.string().min(1),
  message: z.string().optional(),
  // Terminal errors (e.g. payload_too_large) put the room into a surfaced
  // 'error' state that is NOT retried by reconnect loops; only an explicit
  // per-subscription rejoin may retry.
  terminal: z.boolean().optional(),
});

// One-way workspace-level presence push (CLI → renderer). `dataBase64` is an
// EphemeralStore snapshot of the machine + session liveness this CLI itself
// authored — LOCAL-ORIGIN only, never the peers its workspace presence replica
// also holds (`LocalLoroPresenceSource`). It is the renderer's sole presence
// source while offline, and merges with its own cloud replica once online.
// Workspace-level broadcast: consumers filter by `workspaceId`.
const LocalLoroServerPresenceMessageSchema = z.object({
  type: z.literal('presence'),
  protocolVersion: z.literal(LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION),
  workspaceId: z.string().min(1),
  dataBase64: z.string().min(1),
});

const LocalLoroServerMachineMonitorMessageSchema = z.object({
  type: z.literal('machine-monitor'),
  protocolVersion: z.literal(LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION),
  workspaceId: z.string().min(1),
  dataBase64: z.string().min(1),
});

const LocalLoroPongMessageSchema = z.object({
  type: z.literal('pong'),
  protocolVersion: z.literal(LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION),
});

export const LocalLoroDataPlaneServerMessageSchema = z.discriminatedUnion('type', [
  LocalLoroJoinedMessageSchema,
  LocalLoroServerUpdateMessageSchema,
  LocalLoroServerRoomStatusMessageSchema,
  LocalLoroServerErrorMessageSchema,
  LocalLoroServerPresenceMessageSchema,
  LocalLoroServerMachineMonitorMessageSchema,
  LocalLoroPongMessageSchema,
]);

export type LocalLoroDataPlaneRoom = z.infer<typeof LocalLoroDataPlaneRoomSchema>;
export type LocalLoroDataPlanePayload = z.infer<typeof LocalLoroDataPlanePayloadSchema>;
export type LocalLoroDocChunkPayload = z.infer<typeof LocalLoroDocChunkPayloadSchema>;
export type LocalLoroDataPlaneClientMessage = z.infer<typeof LocalLoroDataPlaneClientMessageSchema>;
export type LocalLoroDataPlaneServerMessage = z.infer<typeof LocalLoroDataPlaneServerMessageSchema>;
export type LocalLoroJoinMessage = z.infer<typeof LocalLoroJoinMessageSchema>;
export type LocalLoroUpdateMessage = z.infer<typeof LocalLoroUpdateMessageSchema>;
export type LocalLoroLeaveMessage = z.infer<typeof LocalLoroLeaveMessageSchema>;
export type LocalLoroDetachMessage = z.infer<typeof LocalLoroDetachMessageSchema>;
export type LocalLoroMachineMonitorMessage = z.infer<typeof LocalLoroMachineMonitorMessageSchema>;
export type LocalLoroServerErrorMessage = z.infer<typeof LocalLoroServerErrorMessageSchema>;
export type LocalLoroServerRoomStatusMessage = z.infer<
  typeof LocalLoroServerRoomStatusMessageSchema
> & { status: TransportRoomStatus };

// ---- Flock version vectors ----
//
// Flock's version vector is a plain JSON object (peer → hybrid-logical clock),
// so it travels as a JSON string in the same `haveVersion`/`serverVersion`
// fields that carry base64 Loro VVs for doc rooms. Decoding is fail-open: a
// malformed vector degrades to the empty vector, whose worst case is a
// redundant-but-idempotent full re-export, never a starve.

export type FlockVersionVectorEntry = {
  physicalTime: number;
  logicalCounter: number;
};

// Values are optional to stay structurally compatible with
// @loro-dev/flock-wasm's `VersionVector` interface (its index signature admits
// `undefined`); JSON.stringify drops undefined values, so the wire form is
// always dense.
export type FlockVersionVector = Record<string, FlockVersionVectorEntry | undefined>;

const FlockVersionVectorSchema = z.record(
  z.string(),
  z.object({ physicalTime: z.number(), logicalCounter: z.number() })
);

export function encodeFlockVersion(vector: FlockVersionVector): string {
  return JSON.stringify(vector);
}

export function decodeFlockVersion(encoded: string | undefined): FlockVersionVector {
  if (!encoded) {
    return {};
  }
  try {
    const parsed = FlockVersionVectorSchema.safeParse(JSON.parse(encoded));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function isNewerFlockClock(a: FlockVersionVectorEntry, b: FlockVersionVectorEntry): boolean {
  if (a.physicalTime !== b.physicalTime) {
    return a.physicalTime > b.physicalTime;
  }
  return a.logicalCounter > b.logicalCounter;
}

/** Pointwise max of two flock version vectors (frontier advance never regresses). */
export function mergeFlockVersions(
  a: FlockVersionVector,
  b: FlockVersionVector
): FlockVersionVector {
  const merged: FlockVersionVector = { ...a };
  for (const [peer, clock] of Object.entries(b)) {
    if (!clock) {
      continue;
    }
    const existing = merged[peer];
    if (!existing || isNewerFlockClock(clock, existing)) {
      merged[peer] = clock;
    }
  }
  return merged;
}

// ---- Flock bundle framing ----

// Minimal structural view of a Flock `exportJson` bundle: `version` is the
// bundle FORMAT version (not a version vector); `entries` maps encoded keys to
// self-contained LWW records. We treat records opaquely — chunking only
// repartitions the `entries` map.
type FlockBundleLike = {
  version?: unknown;
  entries?: Record<string, unknown>;
};

export function isEmptyFlockBundle(bundle: unknown): boolean {
  if (typeof bundle !== 'object' || bundle === null) {
    return true;
  }
  const entries = (bundle as FlockBundleLike).entries;
  if (entries === undefined || entries === null || typeof entries !== 'object') {
    return true;
  }
  for (const _key in entries) {
    return false;
  }
  return true;
}

/**
 * Split a flock bundle into frame-budget-sized chunks. Every flock entry is a
 * self-contained LWW record, so each chunk is an independently importable
 * bundle — chunking replaces the terminal `payload_too_large` failure mode for
 * flock rooms entirely. Returns `null` only when a SINGLE entry exceeds the
 * budget (pathological; nothing smaller than one record can be framed).
 */
export function chunkFlockBundle(bundle: unknown, maxBytes: number): unknown[] | null {
  const json = JSON.stringify(bundle);
  if (json.length <= maxBytes) {
    return [bundle];
  }
  if (typeof bundle !== 'object' || bundle === null) {
    return null;
  }
  const { entries, ...rest } = bundle as FlockBundleLike;
  if (!entries) {
    return null;
  }
  // Envelope cost of a chunk with no entries; per-entry cost approximated by
  // the serialized key + record + `"":,` punctuation. Approximation errs high
  // (extra commas), so a chunk can only come in UNDER the budget.
  const baseBytes = JSON.stringify({ ...rest, entries: {} }).length;
  const chunks: unknown[] = [];
  let current: Record<string, unknown> = {};
  let currentBytes = baseBytes;
  let currentCount = 0;
  for (const [key, record] of Object.entries(entries)) {
    const entryBytes = JSON.stringify(key).length + JSON.stringify(record).length + 2;
    if (baseBytes + entryBytes > maxBytes) {
      return null;
    }
    if (currentCount > 0 && currentBytes + entryBytes > maxBytes) {
      chunks.push({ ...rest, entries: current });
      current = {};
      currentBytes = baseBytes;
      currentCount = 0;
    }
    current[key] = record;
    currentBytes += entryBytes;
    currentCount += 1;
  }
  if (currentCount > 0) {
    chunks.push({ ...rest, entries: current });
  }
  return chunks;
}

// ---- Doc update chunk framing ----

export function createDocUpdateTransferId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `transfer:${Date.now()}:${Math.random().toString(36)}`
  );
}

/**
 * Slice an oversized base64 doc update into `doc-update-chunk` payloads, each
 * within the sender's payload budget. The receiver reassembles the full base64
 * string (in order, same connection) and imports once.
 */
export function buildDocUpdateChunkPayloads(
  dataBase64: string,
  maxBytes: number,
  transferId: string
): LocalLoroDocChunkPayload[] {
  const sliceBytes = Math.max(1, maxBytes);
  const chunkCount = Math.ceil(dataBase64.length / sliceBytes);
  const payloads: LocalLoroDocChunkPayload[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    payloads.push({
      kind: 'doc-update-chunk',
      transferId,
      chunkIndex: index,
      chunkCount,
      dataBase64: dataBase64.slice(index * sliceBytes, (index + 1) * sliceBytes),
    });
  }
  return payloads;
}

/**
 * Reassembles `doc-update-chunk` payloads into the original base64 update.
 * Chunks of one transfer arrive in order on one ordered connection. A chunk
 * from a NEW transferId supersedes any partial transfer (the sender enqueues a
 * transfer atomically, so a new one means the previous export was superseded or
 * the peer re-flushed after a send failure). A gap or metadata mismatch drops
 * the partial transfer — unreachable between compliant peers; convergence then
 * falls back to the next (re)join reconciliation, never to a corrupt import.
 */
export class DocUpdateChunkAssembler {
  private transferId: string | null = null;
  private chunkCount = 0;
  private parts: string[] = [];

  reset(): void {
    this.transferId = null;
    this.chunkCount = 0;
    this.parts = [];
  }

  /** Feed one chunk; returns the full base64 string when the transfer completes. */
  push(payload: LocalLoroDocChunkPayload): string | null {
    if (payload.transferId !== this.transferId) {
      this.transferId = payload.transferId;
      this.chunkCount = payload.chunkCount;
      this.parts = [];
    }
    if (payload.chunkCount !== this.chunkCount || payload.chunkIndex !== this.parts.length) {
      this.reset();
      return null;
    }
    this.parts.push(payload.dataBase64);
    if (this.parts.length < this.chunkCount) {
      return null;
    }
    const dataBase64 = this.parts.join('');
    this.reset();
    return dataBase64;
  }
}

export function roomKey(room: LocalLoroDataPlaneRoom): string {
  switch (room.scope) {
    case 'meta':
      return 'meta';
    case 'doc':
      return `doc:${room.docId}`;
    case 'flock-doc':
      return `flock-doc:${room.flockDocId}`;
  }
  const exhaustive: never = room;
  throw new Error(`Unsupported local data-plane room: ${String(exhaustive)}`);
}

export function sameRoom(a: LocalLoroDataPlaneRoom, b: LocalLoroDataPlaneRoom): boolean {
  return roomKey(a) === roomKey(b);
}

/**
 * Stateful UTF-8 decoder for a byte STREAM.
 *
 * `chunk.toString('utf8')` per socket chunk is wrong: a chunk boundary lands at
 * an arbitrary byte offset, so a multi-byte character split across two chunks
 * decodes to U+FFFD on both sides. That is not a cosmetic glitch here — a flock
 * bundle carries file paths as literal UTF-8 JSON, and a corrupted path becomes
 * a NEW LWW key in the receiver's replica, so nothing ever overwrites it and the
 * garbled row survives every later sync.
 *
 * `TextDecoder` with `{ stream: true }` retains the partial sequence until the
 * next chunk completes it, and exists on Node, Electron, and the browser. Keep
 * one decoder per connection.
 */
export function createUtf8StreamDecoder(): (chunk: Uint8Array) => string {
  const decoder = new TextDecoder('utf-8');
  return (chunk) => decoder.decode(chunk, { stream: true });
}

/**
 * Incremental splitter for the newline-delimited JSON framing used on the local
 * data-plane sockets. Feed it raw socket chunks (bytes, or strings that were
 * already decoded by a stateful decoder); it invokes `onLine` once per complete
 * non-empty line. Byte chunks are decoded through one `createUtf8StreamDecoder`
 * per splitter, so the splitter owns framing AND decoding and no caller can
 * reintroduce the split-character bug.
 *
 * When `maxBufferBytes` is set, an oversized line (a partial line whose buffer
 * exceeds the cap, or a complete line above the cap) is discarded up to its
 * terminating newline and `onOverflow` is called once for it; framing then
 * resumes with the next line. Overflow is recoverable by design — receivers
 * must NOT tear down the connection for it (sender-side frame discipline makes
 * it unreachable between compliant peers). Compares char length (O(1)) as an
 * approximate safety cap, not exact bytes.
 */
export function createJsonLineSplitter(options: {
  onLine: (line: string) => void;
  maxBufferBytes?: number;
  onOverflow?: () => void;
}): (chunk: string | Uint8Array) => void {
  const decodeChunk = createUtf8StreamDecoder();
  let parts: string[] = [];
  let bufferedLength = 0;
  let retryChunk = '';
  let discardingOversizedLine = false;
  return (input: string | Uint8Array) => {
    let chunk = typeof input === 'string' ? input : decodeChunk(input);
    if (retryChunk) {
      chunk = retryChunk + chunk;
      retryChunk = '';
    }
    if (discardingOversizedLine) {
      const newlineIndex = chunk.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }
      discardingOversizedLine = false;
      chunk = chunk.slice(newlineIndex + 1);
    }
    let start = 0;
    let newlineIndex = chunk.indexOf('\n');
    try {
      while (newlineIndex >= 0) {
        let line = chunk.slice(start, newlineIndex);
        if (parts.length > 0) {
          parts.push(line);
          line = parts.join('');
          parts = [];
          bufferedLength = 0;
        }
        line = line.trim();
        start = newlineIndex + 1;
        if (line) {
          if (options.maxBufferBytes !== undefined && line.length > options.maxBufferBytes) {
            options.onOverflow?.();
          } else {
            options.onLine(line);
          }
        }
        newlineIndex = chunk.indexOf('\n', start);
      }
    } catch (error) {
      retryChunk = chunk.slice(start);
      throw error;
    }
    if (start < chunk.length) {
      parts.push(chunk.slice(start));
      bufferedLength += chunk.length - start;
    }
    if (options.maxBufferBytes !== undefined && bufferedLength > options.maxBufferBytes) {
      parts = [];
      bufferedLength = 0;
      discardingOversizedLine = true;
      options.onOverflow?.();
    }
  };
}

type GlobalWithBuffer = typeof globalThis & {
  Buffer?: {
    from(
      input: Uint8Array | string,
      encoding?: 'base64'
    ): Uint8Array & { toString(encoding?: 'base64'): string };
  };
};

export function bytesToBase64(bytes: Uint8Array): string {
  const buffer = (globalThis as GlobalWithBuffer).Buffer;
  if (buffer) {
    return buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToBytes(encoded: string): Uint8Array {
  const buffer = (globalThis as GlobalWithBuffer).Buffer;
  if (buffer) {
    return new Uint8Array(buffer.from(encoded, 'base64'));
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
