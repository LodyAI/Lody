import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { open as openYauzl, type Entry, type ZipFile } from 'yauzl';
import {
  BundleFormatError,
  canonicalJson,
  DEFAULT_CHUNK_SIZE,
  MANIFEST_PATH,
  parseManifest,
  sealManifest,
  sha256,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  type BlobDescriptor,
  type BlobEntry,
  type BundleGap,
  type BundleManifest,
  type BundleSource,
  type RoomDescriptor,
  type RoomEntry,
} from './manifest';
import { ZipStoreWriter } from './zip';

export { BundleFormatError } from './manifest';

export type BundleWriter = {
  addRoom(descriptor: RoomDescriptor, bytes: Uint8Array): Promise<RoomEntry>;
  /** Returns the blob's SHA-256; identical content is stored once. */
  addBlob(descriptor: BlobDescriptor, bytes: Uint8Array): Promise<string>;
  addGap(gap: BundleGap): void;
  /** Writes the manifest last, then atomically publishes the file. */
  finish(source: BundleSource): Promise<BundleManifest>;
  /** Removes the partial file; the destination is never created. */
  abort(): Promise<void>;
};

async function assertAbsent(file: string): Promise<void> {
  try {
    await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Destination already exists: ${file}`);
}

export async function createBundleWriter(
  destination: string,
  options: { chunkSize?: number } = {}
): Promise<BundleWriter> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  await assertAbsent(destination);
  const partial = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.partial`
  );
  const handle = await fs.open(partial, 'wx', 0o600);
  const zip = new ZipStoreWriter(handle);
  const rooms: RoomEntry[] = [];
  const blobs = new Map<string, BlobEntry>();
  const gaps: BundleGap[] = [];
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
  };

  return {
    async addRoom(descriptor, bytes) {
      const whole = sha256(bytes);
      const index = rooms.length;
      const chunks: RoomEntry['chunks'] = [];
      for (let start = 0, part = 0; start < bytes.byteLength || part === 0; part++) {
        const chunk = bytes.subarray(start, start + chunkSize);
        const chunkPath = `rooms/${descriptor.model}/${index}-${whole}.${part}`;
        await zip.add(chunkPath, chunk);
        chunks.push({ path: chunkPath, sha256: sha256(chunk), size: chunk.byteLength });
        start += chunkSize;
      }
      const entry: RoomEntry = { ...descriptor, sha256: whole, size: bytes.byteLength, chunks };
      rooms.push(entry);
      return entry;
    },
    async addBlob(descriptor, bytes) {
      const digest = sha256(bytes);
      const existing = blobs.get(digest);
      if (existing) {
        if (descriptor.refs?.length)
          existing.refs = [...new Set([...(existing.refs ?? []), ...descriptor.refs])];
        return digest;
      }
      const blobPath = `blobs/sha256/${digest.slice(0, 2)}/${digest}`;
      await zip.add(blobPath, bytes);
      blobs.set(digest, { ...descriptor, sha256: digest, size: bytes.byteLength, path: blobPath });
      return digest;
    },
    addGap(gap) {
      gaps.push(gap);
    },
    async finish(source) {
      const manifest = sealManifest({
        format: BUNDLE_FORMAT,
        version: BUNDLE_VERSION,
        source,
        rooms,
        blobs: [...blobs.values()],
        gaps,
      });
      await zip.add(MANIFEST_PATH, Buffer.from(canonicalJson(manifest), 'utf8'));
      await zip.finish();
      await handle.sync();
      await close();
      await assertAbsent(destination);
      await fs.rename(partial, destination);
      return manifest;
    },
    async abort() {
      await close().catch(() => undefined);
      await fs.rm(partial, { force: true });
    },
  };
}

export type OpenBundle = {
  manifest: BundleManifest;
  readRoom(entry: RoomEntry): Promise<Uint8Array>;
  readBlob(sha: string): Promise<Uint8Array>;
  /** Reads and checks every room and blob. */
  verifyAll(): Promise<void>;
  close(): Promise<void>;
};

function openZip(file: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    openYauzl(file, { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, zip) =>
      error || !zip
        ? reject(new BundleFormatError(`Cannot read bundle: ${error?.message}`))
        : resolve(zip)
    );
  });
}

function listEntries(zip: ZipFile): Promise<Map<string, Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Entry>();
    zip.on('entry', (entry: Entry) => {
      if (entries.has(entry.fileName)) {
        reject(new BundleFormatError(`Duplicate bundle entry: ${entry.fileName}`));
        return;
      }
      entries.set(entry.fileName, entry);
      zip.readEntry();
    });
    zip.once('end', () => resolve(entries));
    zip.once('error', (error: Error) => reject(new BundleFormatError(error.message)));
    zip.readEntry();
  });
}

function readEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (entry.compressionMethod !== 0) {
      reject(new BundleFormatError(`Compressed bundle entry: ${entry.fileName}`));
      return;
    }
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(new BundleFormatError(`Cannot read ${entry.fileName}: ${error?.message}`));
        return;
      }
      const parts: Buffer[] = [];
      stream.on('data', (part: Buffer) => parts.push(part));
      stream.once('error', (streamError: Error) =>
        reject(new BundleFormatError(streamError.message))
      );
      stream.once('end', () => resolve(Buffer.concat(parts)));
    });
  });
}

export async function openBundle(file: string): Promise<OpenBundle> {
  const zip = await openZip(file);
  try {
    const entries = await listEntries(zip);
    const read = async (name: string, expected: { sha256: string; size: number }) => {
      const entry = entries.get(name);
      if (!entry) throw new BundleFormatError(`Bundle entry missing: ${name}`);
      const bytes = await readEntry(zip, entry);
      if (bytes.byteLength !== expected.size || sha256(bytes) !== expected.sha256)
        throw new BundleFormatError(`Bundle entry is corrupt: ${name}`);
      return bytes;
    };
    const manifestEntry = entries.get(MANIFEST_PATH);
    if (!manifestEntry) throw new BundleFormatError('Bundle is incomplete: no manifest');
    const manifest = parseManifest((await readEntry(zip, manifestEntry)).toString('utf8'));
    const blobs = new Map(manifest.blobs.map((blob) => [blob.sha256, blob]));

    const readRoom = async (entry: RoomEntry) => {
      const parts: Buffer[] = [];
      for (const chunk of entry.chunks) parts.push(await read(chunk.path, chunk));
      const bytes = Buffer.concat(parts);
      if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256)
        throw new BundleFormatError(`Bundle room is corrupt: ${entry.id}`);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    const readBlob = async (sha: string) => {
      const blob = blobs.get(sha);
      if (!blob) throw new BundleFormatError(`Bundle blob missing: ${sha}`);
      const bytes = await read(blob.path, blob);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    return {
      manifest,
      readRoom,
      readBlob,
      async verifyAll() {
        for (const room of manifest.rooms) await readRoom(room);
        for (const blob of manifest.blobs) await readBlob(blob.sha256);
      },
      async close() {
        zip.close();
      },
    };
  } catch (error) {
    zip.close();
    throw error;
  }
}
