import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { CONTROL_STREAM, DEVICE_HEADER } from './platform/protocol';
import { deviceHex } from './platform/device';
import type { HonestClient } from './actors';

export async function appendControlRecord(input: {
  baseUrl: string;
  client: HonestClient;
  genesisHex: string;
  record: Uint8Array;
  expectedOffset?: string;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const framed = new Uint8Array(4 + input.record.length);
  new DataView(framed.buffer).setUint32(0, input.record.length, false);
  framed.set(input.record, 4);
  const response = await fetch(
    `${input.baseUrl}/ds/${input.genesisHex}/${CONTROL_STREAM}/append-cas`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.client.credential!.token}`,
        [DEVICE_HEADER]: deviceHex(input.client.device),
        'content-type': 'application/octet-stream',
        'stream-expected-offset': input.expectedOffset ?? '-1',
      },
      body: Buffer.from(framed),
    }
  );
  return { ok: response.ok, status: response.status, body: await response.text() };
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

export async function riverrunRecordCount(
  riverrunUrl: string,
  genesisHex: string,
  stream = CONTROL_STREAM
): Promise<{ ok: boolean; status: number; count: number }> {
  const base = `${riverrunUrl.replace(/\/$/, '')}/ds/${genesisHex}/${stream}`;
  let offset = '-1';
  let count = 0;
  let status = 0;
  try {
    for (let page = 0; page < 64; page++) {
      const response = await fetch(`${base}?offset=${encodeURIComponent(offset)}`);
      status = response.status;
      if (!response.ok) return { ok: false, status, count };
      const body = new Uint8Array(await response.arrayBuffer());
      count += countFramedRecords(body);
      const next =
        response.headers.get('stream-next-offset') ??
        response.headers.get('Stream-Next-Offset') ??
        offset;
      if (next === offset || body.byteLength === 0) break;
      offset = next;
    }
  } catch {
    return { ok: false, status, count };
  }
  return { ok: true, status, count };
}

export async function riverrunNextOffset(
  riverrunUrl: string,
  genesisHex: string,
  stream = CONTROL_STREAM
): Promise<string> {
  const response = await fetch(`${riverrunUrl.replace(/\/$/, '')}/ds/${genesisHex}/${stream}`, {
    method: 'HEAD',
  });
  return (
    response.headers.get('stream-next-offset') ?? response.headers.get('Stream-Next-Offset') ?? '-1'
  );
}

export async function maliciousAppendCas(input: {
  riverrunUrl: string;
  genesisHex: string;
  record: Uint8Array;
  expectedOffset?: string;
  stream?: string;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const framed = new Uint8Array(4 + input.record.length);
  new DataView(framed.buffer).setUint32(0, input.record.length, false);
  framed.set(input.record, 4);
  const stream = input.stream ?? CONTROL_STREAM;
  const expectedOffset =
    input.expectedOffset ?? (await riverrunNextOffset(input.riverrunUrl, input.genesisHex, stream));
  const response = await fetch(
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
  );
  return { ok: response.ok, status: response.status, body: await response.text() };
}

export function mutateSqliteBytes(path: string, needle: Uint8Array, xor = 0xff): boolean {
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
  const disk = new Uint8Array(readFileSync(path));
  const at = findSubarray(disk, needle);
  if (at < 0) return false;
  disk[at] = (disk[at] ?? 0) ^ xor;
  writeFileSync(path, disk);
  return true;
}

function findSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.byteLength === 0 || needle.byteLength > haystack.byteLength) return -1;
  outer: for (let i = 0; i <= haystack.byteLength - needle.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
