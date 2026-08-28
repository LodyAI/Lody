import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ATTACHMENTS_EXCLUDE_ENTRY,
  buildAttachmentFileName,
  buildAttachmentPromptText,
  buildUnavailableAttachmentPromptText,
  computeExcludeFileContent,
  ensureAttachmentsGitExcluded,
  formatUntrustedFileNameForPrompt,
  resolveContainedUploadPath,
  sanitizeAttachmentFileName,
} from './session-file-attachments';

describe('sanitizeAttachmentFileName', () => {
  it('strips directory traversal to the final component', () => {
    expect(sanitizeAttachmentFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeAttachmentFileName('a/b/c/report.log')).toBe('report.log');
    expect(sanitizeAttachmentFileName('C:\\Windows\\evil.txt')).toBe('evil.txt');
  });

  it('replaces control chars and separators', () => {
    expect(sanitizeAttachmentFileName('na\u0000me\tfoo.txt')).toBe('na_me_foo.txt');
    expect(sanitizeAttachmentFileName('a:b.txt')).toBe('a_b.txt');
  });

  it('never produces dot-only or hidden dotfiles', () => {
    expect(sanitizeAttachmentFileName('.')).toBe('file');
    expect(sanitizeAttachmentFileName('..')).toBe('file');
    expect(sanitizeAttachmentFileName('.gitignore')).toBe('gitignore');
    expect(sanitizeAttachmentFileName('   ')).toBe('file');
  });

  it('bounds length', () => {
    const long = `${'a'.repeat(500)}.txt`;
    expect(sanitizeAttachmentFileName(long).length).toBeLessThanOrEqual(200);
  });
});

describe('buildAttachmentFileName', () => {
  it('prefixes with the first 8 chars of the fileId', () => {
    expect(buildAttachmentFileName('a1b2c3d4e5f6', 'build.log')).toBe('a1b2c3d4-build.log');
  });

  it('sanitizes the fileId prefix', () => {
    expect(buildAttachmentFileName('../weird/id', 'x.txt')).toBe('weirdid-x.txt');
  });

  it('adds a numeric suffix before the extension on collision', () => {
    const existing = new Set(['a1b2c3d4-build.log']);
    expect(buildAttachmentFileName('a1b2c3d4', 'build.log', existing)).toBe('a1b2c3d4-build-1.log');
  });

  it('keeps incrementing past multiple collisions', () => {
    const existing = new Set(['a1b2c3d4-build.log', 'a1b2c3d4-build-1.log']);
    expect(buildAttachmentFileName('a1b2c3d4', 'build.log', existing)).toBe('a1b2c3d4-build-2.log');
  });

  it('handles extensionless names', () => {
    const existing = new Set(['a1b2c3d4-LICENSE']);
    expect(buildAttachmentFileName('a1b2c3d4', 'LICENSE', existing)).toBe('a1b2c3d4-LICENSE-1');
  });
});

describe('computeExcludeFileContent', () => {
  it('appends the entry with a header comment to empty content', () => {
    const result = computeExcludeFileContent('');
    expect(result).not.toBeNull();
    expect(result).toContain(ATTACHMENTS_EXCLUDE_ENTRY);
    expect(result).toContain('# Added by Lody');
  });

  it('is idempotent when the entry is already present', () => {
    const existing = `# existing\nnode_modules/\n${ATTACHMENTS_EXCLUDE_ENTRY}\n`;
    expect(computeExcludeFileContent(existing)).toBeNull();
  });

  it('preserves existing content and appends after a blank line', () => {
    const result = computeExcludeFileContent('node_modules/\ndist/\n');
    expect(result).not.toBeNull();
    expect(result?.startsWith('node_modules/\ndist/\n\n')).toBe(true);
    expect(result?.trimEnd().endsWith(ATTACHMENTS_EXCLUDE_ENTRY)).toBe(true);
  });

  it('does not match a substring or commented occurrence', () => {
    const existing = '# .lody/ is intentionally commented\nsomething.lody/foo\n';
    expect(computeExcludeFileContent(existing)).not.toBeNull();
  });
});

describe('buildAttachmentPromptText', () => {
  it('formats name, size, type, and relative path without inlining content', () => {
    const text = buildAttachmentPromptText({
      fileName: 'build.log',
      sizeBytes: 2_411_724,
      mimeType: 'text/plain',
      relativePath: '.lody/attachments/a1b2c3d4-build.log',
    });
    expect(text).toContain('[User sent a file: build.log (2.3 MB, text/plain)]');
    expect(text).toContain('Saved to: .lody/attachments/a1b2c3d4-build.log');
  });

  it('falls back to octet-stream for an empty mime type', () => {
    const text = buildAttachmentPromptText({
      fileName: 'x',
      sizeBytes: 10,
      mimeType: '',
      relativePath: '.lody/attachments/x',
    });
    expect(text).toContain('application/octet-stream');
    expect(text).toContain('10 B');
  });

  it('escapes brackets and line breaks in the display name', () => {
    expect(formatUntrustedFileNameForPrompt('notes].md')).toBe('notes\\].md');
    const text = buildAttachmentPromptText({
      fileName: 'line one\nline two.log',
      sizeBytes: 12,
      mimeType: 'text/plain',
      relativePath: '.lody/attachments/a1b2c3d4-line two.log',
    });
    expect(text).toContain('line one line two.log');
    expect(text).not.toContain('line one\nline two.log');
  });
});

describe('buildUnavailableAttachmentPromptText', () => {
  it('explains the file is not available without a path', () => {
    const text = buildUnavailableAttachmentPromptText({
      fileName: 'big.bin',
      sizeBytes: 1024,
      mimeType: 'application/octet-stream',
    });
    expect(text).toContain('[User sent a file: big.bin (1 KB, application/octet-stream)]');
    expect(text).toContain('not available yet');
  });
});

describe('ensureAttachmentsGitExcluded', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-attach-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is a no-op for a non-git directory', async () => {
    await ensureAttachmentsGitExcluded(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.git'))).toBe(false);
  });

  it('appends the entry once and is idempotent in a git repo', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tmpDir });

    await ensureAttachmentsGitExcluded(tmpDir);
    const excludePath = path.join(tmpDir, '.git', 'info', 'exclude');
    const first = fs.readFileSync(excludePath, 'utf8');
    expect(first).toContain(ATTACHMENTS_EXCLUDE_ENTRY);

    // Second call must not duplicate the entry.
    await ensureAttachmentsGitExcluded(tmpDir);
    const second = fs.readFileSync(excludePath, 'utf8');
    expect(second).toBe(first);
    const occurrences = second
      .split('\n')
      .filter((line) => line.trim() === ATTACHMENTS_EXCLUDE_ENTRY).length;
    expect(occurrences).toBe(1);
  });
});

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

  it('accepts absolute and relative paths inside the workspace', async () => {
    const nested = path.join(root, 'sub');
    fs.mkdirSync(nested);
    const inside = path.join(nested, 'a.txt');
    fs.writeFileSync(inside, 'x');
    await expect(resolveContainedUploadPath(inside, root)).resolves.toBe(
      path.join(fs.realpathSync(nested), 'a.txt')
    );
    await expect(resolveContainedUploadPath(path.join('sub', 'a.txt'), root)).resolves.toBe(
      path.join(fs.realpathSync(nested), 'a.txt')
    );
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
