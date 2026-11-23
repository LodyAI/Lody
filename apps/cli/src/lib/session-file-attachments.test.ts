import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveContainedUploadPath } from './session-file-attachments';

describe('resolveContainedUploadPath', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-contain-root-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-contain-outside-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('rejects paths outside the workspace', async () => {
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'x');
    await expect(resolveContainedUploadPath(secret, root)).rejects.toThrow(
      /outside the session workspace/
    );
    await expect(
      resolveContainedUploadPath(path.join('..', path.basename(outside), 'secret.txt'), root)
    ).rejects.toThrow(/outside the session workspace|File not found/);
  });

  it('rejects parent-symlink escapes', async () => {
    const escapeDir = path.join(root, 'escape');
    fs.symlinkSync(outside, escapeDir, 'dir');
    const secret = path.join(outside, 'leak.txt');
    fs.writeFileSync(secret, 'x');
    // Path LOOKS inside the workspace but its parent realpath is outside.
    await expect(
      resolveContainedUploadPath(path.join(escapeDir, 'leak.txt'), root)
    ).rejects.toThrow(/outside the session workspace/);
  });
});
