import { describe, expect, it } from 'vitest';

import {
  CODE_COLLAB_FILE_INDEX_LIMITS,
  CODE_COLLAB_LIMITS,
  CodeCollabDomainErrorSchema,
  buildBoundedCodeCollabFileIndexState,
  estimateCodeCollabFileIndexStateBytes,
  applyCodeCollabFileIndexFlockEvents,
  CodeCollabFileEntrySchema,
  authorizeCodeCollabRoleRequest,
  checkRealtimeTextLineLimits,
  classifyCodeCollabFileSystemNode,
  classifyRegularFileContent,
  deriveCodeCollabFileSourceState,
  deriveCodeCollabRoleFromPermissions,
  deriveCodeCollabV2ContentKeyBytes,
  deriveCodeCollabV2ContentKeyId,
  diffCodeCollabFileMetadata,
  findCodeCollabPathCollisions,
  getCodeCollabExecutableFromMode,
  getCodeCollabFileEntryContentAvailability,
  getCodeCollabFileStateContentAvailability,
  getCodeCollabMaxRoleForWorkspaceMember,
  getCodeCollabRepositorySupport,
  hasCodeCollabRoleAtLeast,
  isCodeCollabDomainError,
  normalizeCodeCollabDomainError,
  normalizeWorkspaceRelativePath,
  readCodeCollabFileIndexFromFlock,
  resolveCodeCollabSymlinkTarget,
  serializeCodeCollabText,
  shouldCountForCodeCollabFileLimit,
  writeCodeCollabFileIndexToFlock,
  type CodeCollabFileEntry,
  type CodeCollabV2FileIndexState,
  type CodeCollabV2FileTreeState,
} from '../src/code-collab';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const bytesToHex = (value: Uint8Array): string =>
  Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

const smallLimits = {
  ...CODE_COLLAB_LIMITS,
  maxRealtimeTextBytes: 32,
  maxRealtimeLineUtf8Bytes: 8,
  maxRealtimeLineUtf16CodeUnits: 6,
};

class FakeFileIndexFlock {
  readonly rows = new Map<string, unknown>();
  commits = 0;

  scan(): Iterable<{ readonly key: readonly unknown[]; readonly value: unknown }> {
    return [...this.rows.entries()].map(([workspacePath, value]) => ({
      key: [workspacePath],
      value,
    }));
  }

  set(key: readonly [string], value: unknown): void {
    this.rows.set(key[0], value);
  }

  delete(key: readonly [string]): void {
    this.rows.delete(key[0]);
  }

  commit(): void {
    this.commits += 1;
  }
}

describe('Code Collab shared protocol helpers', () => {
  it('derives deterministic v2 content key material from the owner session id', () => {
    expect(bytesToHex(deriveCodeCollabV2ContentKeyBytes('session-1'))).toBe(
      '53fb8315402c9fb68170c10a6d20c7516b022abf995aa74ea5aa84a6de06e4a7'
    );
    expect(deriveCodeCollabV2ContentKeyId('session-1')).toBe('ccv2:efb61a27dce18cd331dd9f25');
  });

  it('normalizes unknown boundary errors while preserving domain error tags', () => {
    const domainError = CodeCollabDomainErrorSchema.parse({
      code: 'permission-denied',
      message: 'Workspace access is required',
    });

    expect(isCodeCollabDomainError(domainError)).toBe(true);
    expect(normalizeCodeCollabDomainError(domainError)).toEqual(domainError);
    expect(
      normalizeCodeCollabDomainError(
        Object.assign(new Error('EIO: /secret/path'), { code: 'EIO' }),
        {
          code: 'streams-unavailable',
          message: 'Streams access failed',
        }
      )
    ).toEqual({
      code: 'streams-unavailable',
      message: 'Streams access failed',
      redacted: true,
    });
  });

  // A replica poisoned before the data-plane decode fix keeps rows whose key
  // carries U+FFFD. They are LWW records under their own key, so a correct
  // republish never overwrites them: they must be invisible on read and pruned
  // on the next write, or the garbled path stays in the `@file` menu forever.
  it('hides and prunes file-index rows with a corrupted path key', () => {
    const corrupted = '01_CH3.5.5_\uFFFD\uFFFD\uFFFD\u7814\u7a76/README.md';
    const flock = new FakeFileIndexFlock();
    flock.set(['README.md'], { kind: 'text' });
    flock.set([corrupted], { kind: 'text' });

    expect(readCodeCollabFileIndexFromFlock(flock)).toEqual({ 'README.md': { kind: 'text' } });

    expect(writeCodeCollabFileIndexToFlock(flock, { 'README.md': { kind: 'text' } }, 123)).toBe(
      true
    );
    expect([...flock.rows.keys()]).toEqual(['README.md']);

    expect(
      applyCodeCollabFileIndexFlockEvents({}, [{ key: [corrupted], value: { kind: 'text' } }])
    ).toEqual({});
  });

  it('normalizes null optional fields in file-index Flock rows', () => {
    const flock = new FakeFileIndexFlock();
    flock.set(['README.md'], { kind: 'text', change: null });
    flock.set(['large.bin'], {
      kind: 'too_large',
      rawBytes: null,
      compressedBytes: 42,
      change: { diff: null, del: null },
    });

    expect(readCodeCollabFileIndexFromFlock(flock)).toEqual({
      'README.md': { kind: 'text' },
      'large.bin': {
        kind: 'too_large',
        compressedBytes: 42,
        change: {},
      },
    });

    expect(
      applyCodeCollabFileIndexFlockEvents(
        {
          'README.md': true,
        },
        [
          { key: ['README.md'], value: { kind: 'file', change: null } },
          {
            key: ['deleted.txt'],
            value: { kind: 'deleted', change: { diff: null, del: true } },
          },
        ]
      )
    ).toEqual({
      'README.md': { kind: 'file' },
      'deleted.txt': { kind: 'deleted', change: { del: true } },
    });

    expect(
      writeCodeCollabFileIndexToFlock(
        flock,
        {
          'README.md': {
            kind: 'file',
            change: {
              diff: [1, 0],
              del: null,
            },
          },
          'src/index.ts': {
            kind: 'text',
            change: null,
          },
        } as unknown as CodeCollabV2FileIndexState,
        456
      )
    ).toBe(true);
    expect(flock.rows.get('README.md')).toEqual({
      kind: 'file',
      change: { diff: [1, 0] },
    });
    expect(flock.rows.get('src/index.ts')).toEqual({ kind: 'text' });
  });

  it('classifies repository file count support after ordinary-file counting', () => {
    expect(getCodeCollabRepositorySupport(100_000)).toEqual({
      supported: true,
      supportedFileCount: 100_000,
    });
    expect(getCodeCollabRepositorySupport(100_001)).toEqual({
      supported: false,
      reason: 'repository-too-large',
      supportedFileCount: 100_001,
      maxSupportedFiles: 100_000,
    });

    expect(shouldCountForCodeCollabFileLimit('regular-file')).toBe(true);
    expect(shouldCountForCodeCollabFileLimit('directory')).toBe(false);
    expect(shouldCountForCodeCollabFileLimit('symlink')).toBe(false);
    expect(shouldCountForCodeCollabFileLimit('special')).toBe(false);
  });

  it('normalizes workspace-relative slash paths and rejects root escapes', () => {
    expect(normalizeWorkspaceRelativePath('./src\\app.ts')).toEqual({
      ok: true,
      path: 'src/app.ts',
    });
    expect(normalizeWorkspaceRelativePath('../secret')).toEqual({
      ok: false,
      reason: 'traversal',
    });
    expect(normalizeWorkspaceRelativePath('/etc/passwd')).toEqual({
      ok: false,
      reason: 'absolute',
    });
    expect(normalizeWorkspaceRelativePath('C:\\Users\\x')).toEqual({
      ok: false,
      reason: 'windows-drive',
    });
  });

  it('detects case and Unicode path collisions without rewriting paths', () => {
    const collisions = findCodeCollabPathCollisions(
      ['src/Foo.ts', 'src/foo.ts', 'notes/e\u0301.md', 'notes/é.md', 'README.md'],
      { caseSensitive: false }
    );

    expect(collisions).toEqual([
      { comparisonKey: 'src/foo.ts', paths: ['src/Foo.ts', 'src/foo.ts'] },
      { comparisonKey: 'notes/é.md', paths: ['notes/e\u0301.md', 'notes/é.md'] },
    ]);
  });

  it('serializes text while preserving known BOM and EOL metadata', () => {
    const withBom = serializeCodeCollabText({
      text: '\uFEFFa\nb\n',
      textEol: 'crlf',
      hasBom: true,
    });
    expect(Array.from(withBom.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(withBom.slice(3))).toBe('a\r\nb\r\n');

    const mixed = serializeCodeCollabText({
      text: 'a\nb\r\n',
      textEol: 'mixed',
      hasBom: false,
    });
    expect(new TextDecoder().decode(mixed)).toBe('a\nb\r\n');
  });

  it('classifies text size, binary prefix, invalid UTF-8, and long lines separately', () => {
    expect(
      classifyRegularFileContent(
        {
          sizeBytes: 33,
          bytes: bytes('small payload but stat says too large'),
        },
        smallLimits
      )
    ).toMatchObject({ kind: 'large', unavailableReason: 'text-too-large' });

    expect(
      classifyRegularFileContent(
        {
          sizeBytes: 3,
          bytes: new Uint8Array([65, 0, 66]),
        },
        smallLimits
      )
    ).toEqual({ kind: 'binary', sizeBytes: 3 });

    expect(
      classifyRegularFileContent(
        {
          sizeBytes: 1,
          bytes: new Uint8Array([0xff]),
        },
        smallLimits
      )
    ).toMatchObject({ kind: 'large', unavailableReason: 'unsupported-encoding' });

    expect(
      classifyRegularFileContent(
        {
          sizeBytes: bytes('abcdefghi').byteLength,
          bytes: bytes('abcdefghi'),
        },
        smallLimits
      )
    ).toMatchObject({ kind: 'large', unavailableReason: 'line-too-long' });

    expect(checkRealtimeTextLineLimits('abcdefg', smallLimits)).toMatchObject({
      ok: false,
      reason: 'line-too-long',
      lineUtf16CodeUnits: 7,
    });
    expect(checkRealtimeTextLineLimits('ééééé', smallLimits)).toMatchObject({
      ok: false,
      reason: 'line-too-long',
      lineUtf8Bytes: 10,
    });
  });

  it('classifies special filesystem nodes as metadata-only and excludes them from file limits', () => {
    expect(classifyCodeCollabFileSystemNode('regular-file')).toEqual({
      kind: 'regular-file',
      countForFileLimit: true,
    });
    expect(classifyCodeCollabFileSystemNode('socket')).toEqual({
      kind: 'special',
      specialKind: 'socket',
      countForFileLimit: false,
      unavailableReason: 'unsupported-special',
    });
  });

  it('resolves symlinks only through known in-space Flock entries', () => {
    const entries = new Map<string, Pick<CodeCollabFileEntry, 'path' | 'kind' | 'linkTarget'>>([
      ['src/link.ts', { path: 'src/link.ts', kind: 'symlink', linkTarget: '../target.ts' }],
      ['target.ts', { path: 'target.ts', kind: 'text' }],
      ['src/dangling.ts', { path: 'src/dangling.ts', kind: 'symlink', linkTarget: 'missing.ts' }],
      [
        'src/external.ts',
        { path: 'src/external.ts', kind: 'symlink', linkTarget: '../../outside' },
      ],
      ['src/a.ts', { path: 'src/a.ts', kind: 'symlink', linkTarget: 'b.ts' }],
      ['src/b.ts', { path: 'src/b.ts', kind: 'symlink', linkTarget: 'a.ts' }],
    ]);

    expect(resolveCodeCollabSymlinkTarget('src/link.ts', entries)).toEqual({
      kind: 'resolved',
      path: 'target.ts',
    });
    expect(resolveCodeCollabSymlinkTarget('src/dangling.ts', entries)).toEqual({
      kind: 'dangling',
      path: 'src/missing.ts',
    });
    expect(resolveCodeCollabSymlinkTarget('src/external.ts', entries)).toEqual({
      kind: 'external',
      target: '../../outside',
    });
    expect(resolveCodeCollabSymlinkTarget('src/a.ts', entries)).toEqual({
      kind: 'cycle',
      path: 'src/a.ts',
    });
  });

  it('classifies current and historical content availability', () => {
    expect(
      getCodeCollabFileEntryContentAvailability({
        kind: 'text',
        contentDigest: undefined,
      })
    ).toEqual({ available: true, source: 'text-doc' });
    expect(
      getCodeCollabFileEntryContentAvailability({
        kind: 'binary',
        contentDigest: 'sha256-1',
      })
    ).toEqual({ available: true, source: 'blob' });
    expect(
      getCodeCollabFileEntryContentAvailability({
        kind: 'large',
        contentDigest: undefined,
      })
    ).toEqual({ available: false, reason: 'metadata-only' });
    expect(
      getCodeCollabFileEntryContentAvailability({
        kind: 'text',
        contentDigest: undefined,
        unavailableReason: 'permission-denied',
      })
    ).toEqual({ available: false, reason: 'permission-denied' });

    expect(
      getCodeCollabFileStateContentAvailability({
        exists: true,
        kind: 'text',
        path: 'src/app.ts',
        textFrontiers: [{ peer: 'p1', counter: 1 }],
      })
    ).toEqual({ available: true, source: 'text-doc' });
    expect(
      getCodeCollabFileStateContentAvailability({
        exists: true,
        kind: 'text',
        path: 'src/app.ts',
      })
    ).toEqual({ available: false, reason: 'missing-text-frontiers' });
    expect(
      getCodeCollabFileStateContentAvailability(
        {
          exists: true,
          kind: 'binary',
          path: 'image.png',
          blobDigest: 'sha256-1',
        },
        { blobAvailable: false }
      )
    ).toEqual({ available: false, reason: 'blob-expired' });
  });

  it('checks role ordering and validates file entry schemas', () => {
    expect(deriveCodeCollabRoleFromPermissions({ canRead: true })).toBe('read');
    expect(deriveCodeCollabRoleFromPermissions({ canRead: true, canWrite: true })).toBe('write');
    expect(
      deriveCodeCollabRoleFromPermissions({ canRead: true, canWrite: true, canHost: true })
    ).toBe('host');
    expect(deriveCodeCollabRoleFromPermissions({ canRead: false })).toBeNull();
    expect(hasCodeCollabRoleAtLeast('host', 'read')).toBe(true);
    expect(hasCodeCollabRoleAtLeast('write', 'host')).toBe(false);
    expect(
      CodeCollabFileEntrySchema.parse({
        fileId: 'f1',
        path: 'src/app.ts',
        kind: 'text',
        textEol: 'lf',
        hasBom: false,
        executable: false,
      })
    ).toMatchObject({ fileId: 'f1', path: 'src/app.ts' });
  });

  it('derives file source UX state from host, history, and source inputs', () => {
    expect(deriveCodeCollabFileSourceState({ historicalTurn: true })).toBe('historical-turn');
    expect(
      deriveCodeCollabFileSourceState({
        liveHostState: 'online',
        role: 'read',
      })
    ).toBe('live-readonly');
    expect(
      deriveCodeCollabFileSourceState({
        liveHostState: 'online',
        role: 'write',
      })
    ).toBe('live-collaborative');
    expect(deriveCodeCollabFileSourceState({ role: 'write' })).toBe('live-collaborative');
    expect(deriveCodeCollabFileSourceState({ liveHostState: 'offline', role: 'write' })).toBe(
      'host-offline'
    );
    expect(
      deriveCodeCollabFileSourceState({
        liveHostState: 'online',
        role: 'write',
        unavailableReason: 'permission-denied',
      })
    ).toBe('degraded');
  });

  it('detects chmod-only metadata changes separately from content changes', () => {
    expect(getCodeCollabExecutableFromMode(0o100755)).toBe(true);
    expect(getCodeCollabExecutableFromMode(0o100644)).toBe(false);
    expect(
      diffCodeCollabFileMetadata(
        { mode: 0o100644, contentDigest: 'same' },
        { mode: 0o100755, contentDigest: 'same' }
      )
    ).toEqual({ modeChanged: true, executableChanged: true, chmodOnly: true });
    expect(
      diffCodeCollabFileMetadata(
        { mode: 0o100644, contentDigest: 'old' },
        { mode: 0o100755, contentDigest: 'new' }
      )
    ).toEqual({ modeChanged: true, executableChanged: true, chmodOnly: false });
  });

  it('derives Code Collab role authorization from workspace role without platform IO', () => {
    expect(getCodeCollabMaxRoleForWorkspaceMember({ workspaceRole: null })).toBeNull();
    expect(getCodeCollabMaxRoleForWorkspaceMember({ workspaceRole: 'viewer' })).toBe('read');
    expect(getCodeCollabMaxRoleForWorkspaceMember({ workspaceRole: 'member' })).toBe('write');
    expect(
      getCodeCollabMaxRoleForWorkspaceMember({
        workspaceRole: 'admin',
        hostEligible: true,
      })
    ).toBe('host');
    expect(
      getCodeCollabMaxRoleForWorkspaceMember({
        workspaceRole: 'viewer',
        hostEligible: true,
      })
    ).toBe('read');

    expect(
      authorizeCodeCollabRoleRequest({
        workspaceRole: 'member',
        requestedRole: 'write',
      })
    ).toEqual({ ok: true, role: 'write' });
    expect(
      authorizeCodeCollabRoleRequest({
        workspaceRole: 'viewer',
        requestedRole: 'write',
      })
    ).toEqual({ ok: false, reason: 'insufficient-workspace-role' });
    expect(
      authorizeCodeCollabRoleRequest({
        workspaceRole: 'member',
        requestedRole: 'host',
      })
    ).toEqual({ ok: false, reason: 'host-not-eligible' });
    expect(
      authorizeCodeCollabRoleRequest({
        workspaceRole: 'member',
        requestedRole: 'host',
        hostEligible: true,
      })
    ).toEqual({ ok: true, role: 'host' });
  });
});

describe('Code Collab file-index budget', () => {
  it('marks only recorded deletions as deleted and loads other changed paths as files', () => {
    const { fileIndex, omittedPaths } = buildBoundedCodeCollabFileIndexState(
      { 'README.md': true },
      {
        'gone.ts': { diff: [0, 3], del: true },
        'gone.bin': { del: true },
        // Changed but outside the (truncated) tree: still a file on disk.
        'pkg/deep/new.ts': { diff: [4, 0] },
      }
    );
    expect(omittedPaths).toBe(0);
    expect(fileIndex).toEqual({
      'README.md': true,
      'gone.ts': { kind: 'deleted', change: { diff: [0, 3], del: true } },
      'gone.bin': { kind: 'deleted', change: { del: true } },
      'pkg/deep/new.ts': { kind: 'file', change: { diff: [4, 0] } },
      'pkg/deep': { kind: 'lazy' },
      pkg: { kind: 'lazy' },
    });
  });

  it('keeps root entries, expanded directories and changes ahead of breadth-first rows', () => {
    const tree: CodeCollabV2FileTreeState = {
      'README.md': true,
      a: { kind: 'lazy' },
      b: { kind: 'lazy' },
      'b/expanded': { kind: 'lazy' },
    };
    for (let index = 0; index < 50; index += 1) {
      tree[`a/filler-${String(index).padStart(2, '0')}.ts`] = true;
      tree[`b/expanded/child-${String(index).padStart(2, '0')}.ts`] = true;
    }
    tree['a/z/changed.ts'] = true;
    tree['a/z'] = { kind: 'lazy' };

    const { fileIndex, omittedPaths } = buildBoundedCodeCollabFileIndexState(
      tree,
      { 'a/z/changed.ts': { diff: [1, 0] } },
      { budget: { maxEntries: 60, maxBytes: 1024 * 1024 }, priorityDirectories: ['b/expanded'] }
    );
    const paths = Object.keys(fileIndex);
    expect(paths).toHaveLength(60);
    expect(omittedPaths).toBe(Object.keys(tree).length - 60);
    expect(paths).toEqual(expect.arrayContaining(['README.md', 'a', 'b', 'b/expanded']));
    expect(paths.filter((file) => file.startsWith('b/expanded/'))).toHaveLength(50);
    // The changed row is kept together with its ancestors.
    expect(fileIndex['a/z/changed.ts']).toEqual({ kind: 'file', change: { diff: [1, 0] } });
    expect(fileIndex['a/z']).toEqual({ kind: 'lazy' });
    // Omitted rows are not loaded, never deleted.
    expect(Object.values(fileIndex).some((value) => value !== true && value.kind === 'deleted')).toBe(
      false
    );
  });

  it('enforces the byte budget for long multi-byte paths before the row count', () => {
    const tree: CodeCollabV2FileTreeState = { dir: { kind: 'lazy' } };
    for (let index = 0; index < CODE_COLLAB_FILE_INDEX_LIMITS.maxEntries; index += 1) {
      tree[`dir/${'长路径'.repeat(40)}-${index}.ts`] = true;
    }
    const { fileIndex, estimatedBytes } = buildBoundedCodeCollabFileIndexState(tree, {});
    expect(Object.keys(fileIndex).length).toBeLessThan(CODE_COLLAB_FILE_INDEX_LIMITS.maxEntries);
    expect(estimatedBytes).toBe(estimateCodeCollabFileIndexStateBytes(fileIndex));
    expect(estimatedBytes).toBeLessThanOrEqual(CODE_COLLAB_FILE_INDEX_LIMITS.maxBytes);
    expect(estimatedBytes).toBeGreaterThan(CODE_COLLAB_FILE_INDEX_LIMITS.maxBytes - 1024);
  });
});

