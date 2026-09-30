import { Flock } from '@loro-dev/flock-wasm';
import type { LoroDoc } from 'loro-crdt';
import type { RemoteCursor, RemoteCursorStore } from '@loro-dev/streams-crdt/loro';
import { join } from 'node:path';
import { makeLiveFs, type LabFsShape } from '../services/fs';

export function loroDocPath(clientDir: string): string {
  return join(clientDir, 'loro.doc.bin');
}

export function loroCursorPath(clientDir: string): string {
  return join(clientDir, 'loro.cursor.json');
}

export function flockDocPath(clientDir: string): string {
  return join(clientDir, 'flock.doc.bin');
}

export function flockCursorPath(clientDir: string): string {
  return join(clientDir, 'flock.cursor.json');
}

function fsOf(fs?: LabFsShape): LabFsShape {
  return fs ?? makeLiveFs();
}

export function persistLoroDocument(clientDir: string, doc: LoroDoc, fs?: LabFsShape): void {
  const disk = fsOf(fs);
  disk.mkdir(clientDir);
  disk.writeBytes(loroDocPath(clientDir), doc.export({ mode: 'snapshot' }));
}

export function loadLoroDocumentBytes(clientDir: string, fs?: LabFsShape): Uint8Array | null {
  const disk = fsOf(fs);
  const path = loroDocPath(clientDir);
  if (!disk.exists(path)) return null;
  return new Uint8Array(disk.readBytes(path));
}

export function persistFlockDocument(clientDir: string, flock: Flock, fs?: LabFsShape): void {
  const disk = fsOf(fs);
  disk.mkdir(clientDir);
  disk.writeBytes(flockDocPath(clientDir), flock.exportFile());
}

export function loadFlockDocument(
  clientDir: string,
  peerId: string,
  fs?: LabFsShape
): Flock | null {
  const disk = fsOf(fs);
  const path = flockDocPath(clientDir);
  if (!disk.exists(path)) return null;
  return Flock.fromFile(new Uint8Array(disk.readBytes(path)), peerId);
}

function loadCursorFile(path: string, streamUrl: string, disk: LabFsShape): RemoteCursor | null {
  if (!disk.exists(path)) return null;
  const raw = JSON.parse(disk.readText(path)) as RemoteCursor;
  // Same stream path is the same stream: a host restarted on its data directory may
  // listen on another port, and dropping the cursor would re-export local history.
  if (streamPath(raw.streamUrl) !== streamPath(streamUrl)) return null;
  return { ...raw, streamUrl };
}

function streamPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Cursor files are invalid unless the matching document snapshot exists. */
export class FileRemoteCursorStore implements RemoteCursorStore {
  private readonly disk: LabFsShape;

  constructor(
    private readonly clientDir: string,
    private readonly kind: 'loro' | 'flock' = 'loro',
    fs?: LabFsShape
  ) {
    this.disk = fsOf(fs);
  }

  private docPath(): string {
    return this.kind === 'flock' ? flockDocPath(this.clientDir) : loroDocPath(this.clientDir);
  }

  private cursorFile(): string {
    return this.kind === 'flock' ? flockCursorPath(this.clientDir) : loroCursorPath(this.clientDir);
  }

  async load(streamUrl: string): Promise<RemoteCursor | null> {
    if (!this.disk.exists(this.docPath())) return null;
    return loadCursorFile(this.cursorFile(), streamUrl, this.disk);
  }

  async save(cursor: RemoteCursor): Promise<void> {
    if (!this.disk.exists(this.docPath())) {
      throw new Error('cursor-before-document');
    }
    this.disk.mkdir(this.clientDir);
    this.disk.writeText(this.cursorFile(), JSON.stringify(cursor));
  }
}
