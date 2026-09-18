import { Effect } from 'effect';
import { CONTROL_STREAM, DEVICE_HEADER } from './platform/protocol';
import { deviceHex } from './platform/device';
import type { HonestClient } from './actors';
import { LabFs, LabHttp, LiveLabHttp, makeLiveFs, runLabPromise } from './services';

function frameRecord(record: Uint8Array): Uint8Array {
  const framed = new Uint8Array(4 + record.length);
  new DataView(framed.buffer).setUint32(0, record.length, false);
  framed.set(record, 4);
  return framed;
}

/** Malicious-server path: write Riverrun directly, skipping host signature checks. */
export function countFramedRecords(body: Uint8Array): number {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let count = 0;
  let start = 0;
  while (body.byteLength - start >= 4) {
    const length = view.getUint32(start, false);
    if (length <= 0 || start + 4 + length > body.byteLength) break;
    count += 1;
    start += 4 + length;
  }
  return count;
}

export function findSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.byteLength === 0 || needle.byteLength > haystack.byteLength) return -1;
  outer: for (let i = 0; i <= haystack.byteLength - needle.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function appendControlRecordEffect(input: {
  baseUrl: string;
  client: HonestClient;
  genesisHex: string;
  record: Uint8Array;
  expectedOffset?: string;
}): Effect.Effect<{ ok: boolean; status: number; body: string }, unknown, LabHttp> {
  return Effect.gen(function* () {
    const http = yield* LabHttp;
    const framed = frameRecord(input.record);
    const response = yield* Effect.tryPromise({
      try: () =>
        http.fetch(`${input.baseUrl}/ds/${input.genesisHex}/${CONTROL_STREAM}/append-cas`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${input.client.credential!.token}`,
            [DEVICE_HEADER]: deviceHex(input.client.device),
            'content-type': 'application/octet-stream',
            'stream-expected-offset': input.expectedOffset ?? '-1',
          },
          body: Buffer.from(framed),
        }),
      catch: (error) => error,
    });
    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (error) => error,
    });
    return { ok: response.ok, status: response.status, body };
  });
}

export function riverrunRecordCountEffect(
  riverrunUrl: string,
  genesisHex: string,
  stream = CONTROL_STREAM
): Effect.Effect<{ ok: boolean; status: number; count: number }, never, LabHttp> {
  return Effect.gen(function* () {
    const http = yield* LabHttp;
    const base = `${riverrunUrl.replace(/\/$/, '')}/ds/${genesisHex}/${stream}`;
    let offset = '-1';
    let count = 0;
    let status = 0;
    for (let page = 0; page < 64; page++) {
      const response = yield* Effect.tryPromise({
        try: () => http.fetch(`${base}?offset=${encodeURIComponent(offset)}`),
        catch: (error) => error,
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (!response) return { ok: false, status, count };
      status = response.status;
      if (!response.ok) return { ok: false, status, count };
      const body = new Uint8Array(
        yield* Effect.tryPromise({
          try: () => response.arrayBuffer(),
          catch: (error) => error,
        }).pipe(Effect.catchAll(() => Effect.succeed(new ArrayBuffer(0))))
      );
      count += countFramedRecords(body);
      const next =
        response.headers.get('stream-next-offset') ??
        response.headers.get('Stream-Next-Offset') ??
        offset;
      if (next === offset || body.byteLength === 0) break;
      offset = next;
    }
    return { ok: true, status, count };
  });
}

export function riverrunNextOffsetEffect(
  riverrunUrl: string,
  genesisHex: string,
  stream = CONTROL_STREAM
): Effect.Effect<string, unknown, LabHttp> {
  return Effect.gen(function* () {
    const http = yield* LabHttp;
    const response = yield* Effect.tryPromise({
      try: () =>
        http.fetch(`${riverrunUrl.replace(/\/$/, '')}/ds/${genesisHex}/${stream}`, {
          method: 'HEAD',
        }),
      catch: (error) => error,
    });
    return (
      response.headers.get('stream-next-offset') ??
      response.headers.get('Stream-Next-Offset') ??
      '-1'
    );
  });
}

export function maliciousAppendCasEffect(input: {
  riverrunUrl: string;
  genesisHex: string;
  record: Uint8Array;
  expectedOffset?: string;
  stream?: string;
}): Effect.Effect<{ ok: boolean; status: number; body: string }, unknown, LabHttp> {
  return Effect.gen(function* () {
    const http = yield* LabHttp;
    const framed = frameRecord(input.record);
    const stream = input.stream ?? CONTROL_STREAM;
    const expectedOffset =
      input.expectedOffset ??
      (yield* riverrunNextOffsetEffect(input.riverrunUrl, input.genesisHex, stream));
    const response = yield* Effect.tryPromise({
      try: () =>
        http.fetch(
          `${input.riverrunUrl.replace(/\/$/, '')}/ds/${input.genesisHex}/${stream}/append-cas`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/octet-stream',
              'stream-expected-offset': expectedOffset,
              'stream-extensions': 'append-cas',
            },
            body: Buffer.from(framed),
          }
        ),
      catch: (error) => error,
    });
    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (error) => error,
    });
    return { ok: response.ok, status: response.status, body };
  });
}

export function mutateSqliteBytesEffect(
  path: string,
  needle: Uint8Array,
  xor = 0xff
): Effect.Effect<boolean, never, LabFs> {
  return Effect.gen(function* () {
    const fs = yield* LabFs;
    for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
      if (fs.exists(sidecar)) fs.unlink(sidecar);
    }
    const disk = new Uint8Array(fs.readBytes(path));
    const at = findSubarray(disk, needle);
    if (at < 0) return false;
    disk[at] = (disk[at] ?? 0) ^ xor;
    fs.writeBytes(path, disk);
    return true;
  });
}

/** Promise wrappers — same Effect implementation under LiveLabHttp. */
export function appendControlRecord(input: {
  baseUrl: string;
  client: HonestClient;
  genesisHex: string;
  record: Uint8Array;
  expectedOffset?: string;
}): Promise<{ ok: boolean; status: number; body: string }> {
  return runLabPromise(appendControlRecordEffect(input), LiveLabHttp);
}

export function riverrunRecordCount(
  riverrunUrl: string,
  genesisHex: string,
  stream = CONTROL_STREAM
): Promise<{ ok: boolean; status: number; count: number }> {
  return runLabPromise(riverrunRecordCountEffect(riverrunUrl, genesisHex, stream), LiveLabHttp);
}

export function riverrunNextOffset(
  riverrunUrl: string,
  genesisHex: string,
  stream = CONTROL_STREAM
): Promise<string> {
  return runLabPromise(riverrunNextOffsetEffect(riverrunUrl, genesisHex, stream), LiveLabHttp);
}

export function maliciousAppendCas(input: {
  riverrunUrl: string;
  genesisHex: string;
  record: Uint8Array;
  expectedOffset?: string;
  stream?: string;
}): Promise<{ ok: boolean; status: number; body: string }> {
  return runLabPromise(maliciousAppendCasEffect(input), LiveLabHttp);
}

/** Sync Live LabFs path for matrix tests. AttackLab uses `mutateSqliteBytesEffect`. */
export function mutateSqliteBytes(path: string, needle: Uint8Array, xor = 0xff): boolean {
  return Effect.runSync(
    mutateSqliteBytesEffect(path, needle, xor).pipe(Effect.provideService(LabFs, makeLiveFs()))
  );
}
