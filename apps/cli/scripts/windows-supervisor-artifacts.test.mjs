import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertWindowsSupervisorArtifacts,
  buildWindowsSupervisor,
  windowsSupervisorName,
} from './windows-supervisor-artifacts.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-supervisor-artifacts-'));
  t.after(() => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(directory, 'windows-process-launcher.js'), 'export {};');
  return directory;
}

function writePe(directory, arch, machine = arch === 'x64' ? 0x8664 : 0xaa64) {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(128, 0x3c);
  bytes.writeUInt32LE(0x00004550, 128);
  bytes.writeUInt16LE(machine, 132);
  bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(112, 148);
  bytes.writeUInt16LE(2, 150);
  bytes.writeUInt16LE(0x20b, 152);
  fs.writeFileSync(path.join(directory, windowsSupervisorName(arch)), bytes);
}

test('universal package requires independently matching x64 and ARM64 images', (t) => {
  const directory = fixture(t);
  writePe(directory, 'x64');
  assert.throws(
    () => assertWindowsSupervisorArtifacts({ directory, architectures: ['x64', 'arm64'] }),
    /Missing Windows supervisor/
  );
  writePe(directory, 'arm64', 0x8664);
  assert.throws(
    () => assertWindowsSupervisorArtifacts({ directory, architectures: ['x64', 'arm64'] }),
    /expected arm64/
  );
  writePe(directory, 'arm64');
  assertWindowsSupervisorArtifacts({ directory, architectures: ['x64', 'arm64'] });
});

test('a launcher hidden in chunks does not satisfy the flat runtime layout', (t) => {
  const directory = fixture(t);
  writePe(directory, 'x64');
  fs.mkdirSync(path.join(directory, 'chunks'));
  fs.renameSync(
    path.join(directory, 'windows-process-launcher.js'),
    path.join(directory, 'chunks', 'windows-process-launcher.js')
  );
  assert.throws(
    () => assertWindowsSupervisorArtifacts({ directory, architectures: ['x64'] }),
    /Missing flat Windows process launcher/
  );
});

test('truncated and malformed PE files fail before packaging', (t) => {
  const directory = fixture(t);
  const binary = path.join(directory, windowsSupervisorName('x64'));
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(63), Buffer.alloc(100)]) {
    fs.writeFileSync(binary, bytes);
    assert.throws(
      () => assertWindowsSupervisorArtifacts({ directory, architectures: ['x64'] }),
      /Invalid Windows supervisor PE/
    );
  }
  writePe(directory, 'x64');
  const corrupt = fs.readFileSync(binary);
  corrupt.writeUInt32LE(0xffffffff, 0x3c);
  fs.writeFileSync(binary, corrupt);
  assert.throws(
    () => assertWindowsSupervisorArtifacts({ directory, architectures: ['x64'] }),
    /Invalid Windows supervisor PE/
  );
});

test('Mac and Linux JS builds do not invoke a Windows compiler', () => {
  for (const platform of ['darwin', 'linux']) {
    buildWindowsSupervisor({ directory: 'not-created', platform });
  }
  assert.throws(() => windowsSupervisorName('ia32'), /Unsupported Windows supervisor architecture/);
});

test('PE headers and section extents must describe a complete 64-bit executable', (t) => {
  const directory = fixture(t);
  const binary = path.join(directory, windowsSupervisorName('x64'));
  for (const corrupt of [
    (bytes) => bytes.writeUInt16LE(0, 134),
    (bytes) => bytes.writeUInt16LE(0x10b, 152),
    (bytes) => bytes.writeUInt16LE(0, 150),
    (bytes) => bytes.writeUInt32LE(1024, 128 + 24 + 112 + 16),
  ]) {
    writePe(directory, 'x64');
    const bytes = fs.readFileSync(binary);
    corrupt(bytes);
    fs.writeFileSync(binary, bytes);
    assert.throws(
      () => assertWindowsSupervisorArtifacts({ directory, architectures: ['x64'] }),
      /Windows supervisor PE/
    );
  }
});
