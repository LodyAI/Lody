import { describe, expect, it } from 'vitest';
import { encodeSessionFilePath, type SessionProjectRun } from '@lody/shared';
import {
  buildSessionFileRootMounts,
  remapSessionFileRecord,
  toSessionFileDisplayPath,
  toSessionFileRequestPath,
} from '../src/lib/session-file-root-mounts';

const run = {
  id: '0b9a4a6e-6d2f-4f3a-9a53-0f3d1f0b2c11',
  name: 'Shop',
  root: 'project-shop-0b9a4a6e-6d2f-4f3a-9a53-0f3d1f0b2c11',
  members: {
    api: {
      o: 0,
      access: 'worktree',
      src: { kind: 'github', repoFullName: 'acme/api' },
      placement: { kind: 'root', dir: 'api' },
      path: 'api',
      base: 'HEAD',
    },
    docs: {
      o: 1,
      access: 'additional',
      src: { kind: 'local', machineId: 'm1', localProjectId: 'docs' },
      placement: { kind: 'root', dir: 'docs' },
      path: 'docs',
      base: 'HEAD',
    },
    assets: {
      o: 2,
      access: 'link',
      src: { kind: 'local', machineId: 'm1', localProjectId: 'assets' },
      placement: { kind: 'root', dir: 'assets' },
      path: 'assets',
      base: 'HEAD',
    },
  },
} as unknown as SessionProjectRun;

const docsKey = (relativePath: string) =>
  encodeSessionFilePath({ rootId: 'member:docs', relativePath });

describe('session file root mounts', () => {
  const mounts = buildSessionFileRootMounts(run);

  it('mounts only members outside the main directory', () => {
    expect(mounts.map((mount) => [mount.rootId, mount.mountPath])).toEqual([
      ['member:docs', 'docs'],
      ['member:assets', 'assets'],
    ]);
    expect(buildSessionFileRootMounts(undefined)).toEqual([]);
  });

  it('shows member keys under their mount and leaves main paths unchanged', () => {
    expect(toSessionFileDisplayPath(docsKey('guide/intro.md'), mounts)).toBe('docs/guide/intro.md');
    expect(toSessionFileDisplayPath('api/src/main.go', mounts)).toBe('api/src/main.go');
    // A root this snapshot does not mount never shows a NUL.
    expect(
      toSessionFileDisplayPath(
        encodeSessionFilePath({ rootId: 'member:gone' as string, relativePath: 'a.md' }),
        mounts
      )
    ).toBe('member-gone/a.md');
  });

  it('splits display paths and raw keys back into rootId and relative path', () => {
    expect(toSessionFileRequestPath('docs/guide/intro.md', mounts)).toEqual({
      rootId: 'member:docs',
      path: 'guide/intro.md',
    });
    expect(toSessionFileRequestPath(docsKey('a.md'), mounts)).toEqual({
      rootId: 'member:docs',
      path: 'a.md',
    });
    expect(toSessionFileRequestPath('api/main.go', mounts)).toEqual({ path: 'api/main.go' });
    // The mount directory itself and look-alike prefixes stay main paths.
    expect(toSessionFileRequestPath('docs', mounts)).toEqual({ path: 'docs' });
    expect(toSessionFileRequestPath('docs-old/a.md', mounts)).toEqual({ path: 'docs-old/a.md' });
  });

  it('re-keys a file tree only when it holds member keys', () => {
    const plain = { 'api/a.go': true as const };
    expect(remapSessionFileRecord(plain, mounts)).toBe(plain);
    expect(
      Object.keys(remapSessionFileRecord({ ...plain, [docsKey('b.md')]: true as const }, mounts))
    ).toEqual(['api/a.go', 'docs/b.md']);
  });

  it('round-trips through the shared encoding', () => {
    const key = docsKey('x/y.ts');
    const display = toSessionFileDisplayPath(key, mounts);
    expect(toSessionFileRequestPath(display, mounts)).toEqual({
      rootId: 'member:docs',
      path: 'x/y.ts',
    });
  });
});
