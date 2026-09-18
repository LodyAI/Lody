import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { Context, Layer } from 'effect';

export interface LabFsShape {
  readonly exists: (path: string) => boolean;
  readonly readBytes: (path: string) => Uint8Array;
  readonly readText: (path: string) => string;
  readonly writeBytes: (path: string, bytes: Uint8Array) => void;
  readonly writeText: (path: string, text: string) => void;
  readonly mkdir: (path: string) => void;
  readonly unlink: (path: string) => void;
}

export class LabFs extends Context.Tag('lody/e2ee-lab/LabFs')<LabFs, LabFsShape>() {}

export function makeLiveFs(): LabFsShape {
  return {
    exists: (path) => existsSync(path),
    readBytes: (path) => new Uint8Array(readFileSync(path)),
    readText: (path) => readFileSync(path, 'utf8'),
    writeBytes: (path, bytes) => {
      writeFileSync(path, bytes);
    },
    writeText: (path, text) => {
      writeFileSync(path, text);
    },
    mkdir: (path) => {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    },
    unlink: (path) => {
      unlinkSync(path);
    },
  };
}

export const LiveLabFs = Layer.succeed(LabFs, makeLiveFs());

/** In-memory filesystem for AttackLab unit tests. */
export function makeMemoryFs(
  initial: Record<string, Uint8Array> = {}
): LabFsShape & { files: Map<string, Uint8Array>; dirs: Set<string> } {
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, bytes]) => [path, new Uint8Array(bytes)])
  );
  const dirs = new Set<string>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    files,
    dirs,
    exists: (path) => files.has(path) || dirs.has(path),
    readBytes: (path) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`enoent:${path}`);
      return new Uint8Array(bytes);
    },
    readText: (path) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`enoent:${path}`);
      return decoder.decode(bytes);
    },
    writeBytes: (path, bytes) => {
      files.set(path, new Uint8Array(bytes));
    },
    writeText: (path, text) => {
      files.set(path, encoder.encode(text));
    },
    mkdir: (path) => {
      dirs.add(path);
    },
    unlink: (path) => {
      files.delete(path);
      dirs.delete(path);
    },
  };
}

export function MemoryLabFs(
  initial: Record<string, Uint8Array> = {}
): Layer.Layer<LabFs> & { readonly fs: ReturnType<typeof makeMemoryFs> } {
  const fs = makeMemoryFs(initial);
  return Object.assign(Layer.succeed(LabFs, fs), { fs });
}
