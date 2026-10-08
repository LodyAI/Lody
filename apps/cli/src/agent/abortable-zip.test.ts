import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { deflateRawSync } from 'node:zlib';

import { open as openYauzl, type Entry, type ZipFile } from 'yauzl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractAbortableZip } from './abortable-zip';

type OpenZip = NonNullable<Parameters<typeof extractAbortableZip>[3]>;
type CreateEntryWriteStream = NonNullable<Parameters<typeof extractAbortableZip>[4]>;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function deflatedZip(fileName: string, contents: Buffer): Buffer {
  const name = Buffer.from(fileName);
  const compressed = deflateRawSync(contents);
  const checksum = crc32(contents);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(compressed.byteLength, 18);
  localHeader.writeUInt32LE(contents.byteLength, 22);
  localHeader.writeUInt16LE(name.byteLength, 26);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(0x0314, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(compressed.byteLength, 20);
  centralHeader.writeUInt32LE(contents.byteLength, 24);
  centralHeader.writeUInt16LE(name.byteLength, 28);
  centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);

  const centralOffset = localHeader.byteLength + name.byteLength + compressed.byteLength;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralHeader.byteLength + name.byteLength, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([localHeader, name, compressed, centralHeader, name, end]);
}

/** Deterministic bytes that deflate cannot shrink, so the entry spans many reads. */
function incompressibleBytes(byteLength: number): Buffer {
  const bytes = Buffer.alloc(byteLength);
  let state = 0x9e3779b9;
  for (let offset = 0; offset + 4 <= byteLength; offset += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes.writeUInt32LE(state >>> 0, offset);
  }
  return bytes;
}

function entry(fileName: string): Entry {
  return {
    fileName,
    externalFileAttributes: 0o100644 << 16,
    versionMadeBy: 3 << 8,
  } as Entry;
}

class FakeZipFile extends EventEmitter {
  isOpen = true;
  readonly reader = new EventEmitter();
  private entryRead = false;

  constructor(
    private readonly value: Entry,
    private readonly streamFactory: () => Readable,
    private readonly closeError?: Error
  ) {
    super();
    this.reader.on('error', (error: Error) => this.emit('error', error));
    this.reader.on('close', () => this.emit('close'));
  }

  readEntry(): void {
    queueMicrotask(() => {
      if (!this.entryRead) {
        this.entryRead = true;
        this.emit('entry', this.value);
        return;
      }
      this.emit('end');
    });
  }

  openReadStream(_entry: Entry, callback: (error: Error | null, stream: Readable) => void): void {
    callback(null, this.streamFactory());
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    queueMicrotask(() => {
      if (this.closeError) {
        this.reader.emit('error', this.closeError);
        return;
      }
      this.reader.emit('close');
    });
  }
}

function openFake(zipFile: FakeZipFile): OpenZip {
  return (_path, _options, callback) => callback(null, zipFile as unknown as ZipFile);
}

describe('extractAbortableZip', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'abortable-zip-test-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('extracts entries and waits for the ZIP reader to close', async () => {
    const zipFile = new FakeZipFile(entry('bin/agent'), () => Readable.from('agent-bytes'));
    const outputDir = join(rootDir, 'output');

    await extractAbortableZip(
      join(rootDir, 'archive.zip'),
      outputDir,
      new AbortController().signal,
      openFake(zipFile)
    );

    expect(zipFile.isOpen).toBe(false);
    expect(await readFile(join(outputDir, 'bin', 'agent'), 'utf8')).toBe('agent-bytes');
  });

  it('extracts a real deflated entry that spans many reads', async () => {
    // yauzl 2.x stalled here on Node 24.16+ (#1185).
    const payload = incompressibleBytes(1024 * 1024);
    const archivePath = join(rootDir, 'multi-read.zip');
    await writeFile(archivePath, deflatedZip('agent', payload));

    await extractAbortableZip(archivePath, join(rootDir, 'output'), new AbortController().signal);

    const extracted = await readFile(join(rootDir, 'output', 'agent'));
    expect(createHash('sha256').update(extracted).digest('hex')).toBe(
      createHash('sha256').update(payload).digest('hex')
    );
  });

  it('destroys the active entry and waits for its I/O to quiesce on abort', async () => {
    let activeStream!: Readable;
    let markStreamOpened!: () => void;
    const streamOpened = new Promise<void>((resolveOpened) => {
      markStreamOpened = resolveOpened;
    });
    let releaseDestroy!: () => void;
    const destroyStarted = new Promise<void>((resolveDestroyStarted) => {
      let pushed = false;
      activeStream = new Readable({
        read() {
          if (pushed) return;
          pushed = true;
          this.push(Buffer.from('first-chunk'));
        },
        destroy(error, callback) {
          resolveDestroyStarted();
          releaseDestroy = () => callback(error);
        },
      });
    });
    const zipFile = new FakeZipFile(entry('agent'), () => {
      markStreamOpened();
      return activeStream;
    });
    const controller = new AbortController();
    const extraction = extractAbortableZip(
      join(rootDir, 'archive.zip'),
      join(rootDir, 'output'),
      controller.signal,
      openFake(zipFile)
    );
    let extractionSettled = false;
    void extraction.then(
      () => {
        extractionSettled = true;
      },
      () => {
        extractionSettled = true;
      }
    );
    await streamOpened;

    controller.abort();
    await destroyStarted;
    await Promise.resolve();
    expect(activeStream.destroyed).toBe(true);
    expect(extractionSettled).toBe(false);

    releaseDestroy();
    await expect(extraction).rejects.toMatchObject({ name: 'AbortError' });
    expect(extractionSettled).toBe(true);
    expect(zipFile.isOpen).toBe(false);
  });

  it('settles after aborting an active real deflated entry', async () => {
    const archivePath = join(rootDir, 'deflated.zip');
    await writeFile(archivePath, deflatedZip('large.txt', Buffer.alloc(64 * 1024, 0x61)));
    const controller = new AbortController();
    let readerClosed = false;
    const openRealZip: OpenZip = (path, options, callback) => {
      openYauzl(path, options, (error, zipFile) => {
        if (error) {
          callback(error, zipFile);
          return;
        }
        const originalOpenReadStream = zipFile.openReadStream.bind(zipFile);
        zipFile.openReadStream = ((
          value: Entry,
          done: (error: Error | null, stream: Readable) => void
        ) => {
          originalOpenReadStream(value, (streamError, stream) => {
            stream.once('data', () => queueMicrotask(() => controller.abort()));
            done(streamError, stream);
          });
        }) as typeof zipFile.openReadStream;
        zipFile.once('close', () => {
          readerClosed = true;
        });
        callback(null, zipFile);
      });
    };

    await expect(
      extractAbortableZip(archivePath, join(rootDir, 'real-output'), controller.signal, openRealZip)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(readerClosed).toBe(true);
  });

  it('rejects traversal before opening an entry stream', async () => {
    let openedEntry = false;
    const zipFile = new FakeZipFile(entry('../outside'), () => {
      openedEntry = true;
      return Readable.from('unsafe');
    });

    await expect(
      extractAbortableZip(
        join(rootDir, 'archive.zip'),
        join(rootDir, 'output'),
        new AbortController().signal,
        openFake(zipFile)
      )
    ).rejects.toThrow('Out of bound path');

    expect(openedEntry).toBe(false);
    expect(existsSync(join(rootDir, 'outside'))).toBe(false);
  });

  it('rejects instead of hanging when the ZIP reader fails to close', async () => {
    const zipFile = new FakeZipFile(
      entry('agent'),
      () => Readable.from('agent-bytes'),
      new Error('close EIO')
    );

    await expect(
      extractAbortableZip(
        join(rootDir, 'archive.zip'),
        join(rootDir, 'output'),
        new AbortController().signal,
        openFake(zipFile)
      )
    ).rejects.toThrow('close EIO');
  });

  it('handles a close error immediately while output teardown is still pending', async () => {
    const controller = new AbortController();
    let pushed = false;
    const source = new Readable({
      read() {
        if (pushed) return;
        pushed = true;
        this.push(Buffer.from('active-entry'));
      },
    });
    const zipFile = new FakeZipFile(
      entry('agent'),
      () => source,
      new Error('close EIO while writer is closing')
    );
    let releaseWriterDestroy: (() => void) | undefined;
    let markWriterDestroyStarted!: () => void;
    const writerDestroyStarted = new Promise<void>((resolveStarted) => {
      markWriterDestroyStarted = resolveStarted;
    });
    let abortScheduled = false;
    const createBlockedWriter: CreateEntryWriteStream = () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          if (!abortScheduled) {
            abortScheduled = true;
            queueMicrotask(() => controller.abort());
          }
          callback();
        },
        destroy(error, callback) {
          markWriterDestroyStarted();
          releaseWriterDestroy = () => callback(error);
        },
      });
    const unhandled: unknown[] = [];
    const handleUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', handleUnhandled);
    const extraction = extractAbortableZip(
      join(rootDir, 'archive.zip'),
      join(rootDir, 'output'),
      controller.signal,
      openFake(zipFile),
      createBlockedWriter
    );
    const observedError = extraction.then(
      () => undefined,
      (error: unknown) => error
    );

    try {
      await writerDestroyStarted;
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', handleUnhandled);
      releaseWriterDestroy?.();
    }

    await expect(observedError).resolves.toMatchObject({ name: 'AbortError' });
  });
});
