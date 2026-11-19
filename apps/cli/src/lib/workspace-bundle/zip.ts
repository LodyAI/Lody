import type { FileHandle } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

/** Streaming store-only ZIP writer; emits ZIP64 records past the classic limits. */
const U32 = 0xffffffff;
const U16 = 0xffff;
// DOS date 1980-01-01 00:00: entries carry no timestamps.
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

type Written = { name: Buffer; crc: number; size: number; offset: number };

export class ZipStoreWriter {
  private offset = 0;
  private readonly entries: Written[] = [];
  private readonly names = new Set<string>();

  constructor(private readonly handle: FileHandle) {}

  async add(name: string, bytes: Uint8Array): Promise<void> {
    if (this.names.has(name)) throw new Error(`Duplicate bundle entry: ${name}`);
    this.names.add(name);
    const encoded = Buffer.from(name, 'utf8');
    const crc = crc32(bytes);
    const zip64 = bytes.byteLength >= U32;
    const extra = zip64 ? zip64Extra([bytes.byteLength, bytes.byteLength]) : Buffer.alloc(0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(zip64 ? U32 : bytes.byteLength, 18);
    header.writeUInt32LE(zip64 ? U32 : bytes.byteLength, 22);
    header.writeUInt16LE(encoded.length, 26);
    header.writeUInt16LE(extra.length, 28);
    const entry = { name: encoded, crc, size: bytes.byteLength, offset: this.offset };
    await this.write(Buffer.concat([header, encoded, extra]));
    await this.write(bytes);
    this.entries.push(entry);
  }

  async finish(): Promise<void> {
    const centralStart = this.offset;
    for (const entry of this.entries) {
      const needs = [entry.size >= U32, entry.size >= U32, entry.offset >= U32];
      const values = [entry.size, entry.size, entry.offset].filter((_, index) => needs[index]);
      const extra = values.length > 0 ? zip64Extra(values) : Buffer.alloc(0);
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(45, 4);
      header.writeUInt16LE(values.length > 0 ? 45 : 20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt16LE(DOS_DATE, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(needs[0] ? U32 : entry.size, 20);
      header.writeUInt32LE(needs[1] ? U32 : entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(extra.length, 30);
      header.writeUInt32LE(needs[2] ? U32 : entry.offset, 42);
      await this.write(Buffer.concat([header, entry.name, extra]));
    }
    const centralSize = this.offset - centralStart;
    const count = this.entries.length;
    const zip64 = count >= U16 || centralStart >= U32 || centralSize >= U32;
    if (zip64) {
      const record = Buffer.alloc(56);
      const recordOffset = this.offset;
      record.writeUInt32LE(0x06064b50, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE(45, 12);
      record.writeUInt16LE(45, 14);
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(centralSize), 40);
      record.writeBigUInt64LE(BigInt(centralStart), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(recordOffset), 8);
      locator.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([record, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(zip64 ? U16 : count, 8);
    end.writeUInt16LE(zip64 ? U16 : count, 10);
    end.writeUInt32LE(zip64 ? U32 : centralSize, 12);
    end.writeUInt32LE(zip64 ? U32 : centralStart, 16);
    await this.write(end);
  }

  private async write(bytes: Uint8Array): Promise<void> {
    let written = 0;
    while (written < bytes.byteLength) {
      const { bytesWritten } = await this.handle.write(bytes, written, bytes.byteLength - written);
      written += bytesWritten;
    }
    this.offset += bytes.byteLength;
  }
}

function zip64Extra(values: number[]): Buffer {
  const extra = Buffer.alloc(4 + values.length * 8);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + index * 8));
  return extra;
}
