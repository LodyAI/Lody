import { describe, expect, it } from 'vitest';
import {
  createFakeSessionFileProvider,
  type SessionFileProviderEntry,
} from '../src/lib/session-file-provider';
import { resolveSessionFileProviderOpenPath } from '../src/lib/session-file-provider-symlink';
import { loadSessionFileQuickOpenItems } from '../src/components/sessions/session-file-quick-open';
import { buildMentionFilePathsEntryFromProviderEntries } from '../src/components/mentions/mention-project-file-source';
import { buildFileTreeFromSessionFileProviderEntries } from '../src/hooks/use-code-session';

const files = [
  {
    fileId: 't:target',
    path: 'src/target.ts',
    kind: 'text',
    sourceState: 'live-collaborative',
  },
  {
    path: 'src/link.ts',
    kind: 'symlink',
    sourceState: 'degraded',
    readonly: true,
    linkTarget: './target.ts',
    unavailableReason: 'metadata-only',
  },
  {
    path: 'src/dangling.ts',
    kind: 'symlink',
    sourceState: 'degraded',
    readonly: true,
    linkTarget: './missing.ts',
    unavailableReason: 'metadata-only',
  },
  {
    path: 'src/external.ts',
    kind: 'symlink',
    sourceState: 'degraded',
    readonly: true,
    linkTarget: '../../outside.ts',
    unavailableReason: 'metadata-only',
  },
  {
    path: 'src/cycle-a.ts',
    kind: 'symlink',
    sourceState: 'degraded',
    readonly: true,
    linkTarget: './cycle-b.ts',
    unavailableReason: 'metadata-only',
  },
  {
    path: 'src/cycle-b.ts',
    kind: 'symlink',
    sourceState: 'degraded',
    readonly: true,
    linkTarget: './cycle-a.ts',
    unavailableReason: 'metadata-only',
  },
] satisfies readonly SessionFileProviderEntry[];

describe('session file provider symlink open path resolution', () => {
  it('redirects symlink paths produced by shared file entry points', async () => {
    const provider = createFakeSessionFileProvider({ files });
    const providerEntries = await provider.listFiles();
    const fileTree = buildFileTreeFromSessionFileProviderEntries(providerEntries);
    const srcNode = fileTree.find((entry) => entry.path === 'src');
    const fileTreePath =
      srcNode?.type === 'directory'
        ? srcNode.children?.find((entry) => entry.path === 'src/link.ts')?.path
        : undefined;
    const quickOpenPath = (
      await loadSessionFileQuickOpenItems({
        provider,
        query: 'link',
      })
    )[0]?.path;
    const mentionPath = buildMentionFilePathsEntryFromProviderEntries(providerEntries).paths.find(
      (path) => path === 'src/link.ts'
    );

    const entryPointPaths = [
      { path: fileTreePath, source: 'fileTree' },
      { path: mentionPath, source: 'mention' },
      { path: quickOpenPath, source: 'quickOpen' },
      { path: 'src/link.ts', source: 'urlState' },
    ];

    expect(Object.fromEntries(entryPointPaths.map((entry) => [entry.source, entry.path]))).toEqual({
      fileTree: 'src/link.ts',
      mention: 'src/link.ts',
      quickOpen: 'src/link.ts',
      urlState: 'src/link.ts',
    });

    for (const { path } of entryPointPaths) {
      if (!path) {
        throw new Error('Expected shared entry point to expose a symlink path');
      }
      await expect(resolveSessionFileProviderOpenPath(provider, path)).resolves.toEqual({
        path: 'src/target.ts',
        redirected: true,
        from: 'src/link.ts',
        fileId: 't:target',
      });
    }
  });

  it('keeps unresolved symlinks on their metadata entry', async () => {
    const provider = createFakeSessionFileProvider({ files });

    await expect(resolveSessionFileProviderOpenPath(provider, 'src/dangling.ts')).resolves.toEqual({
      path: 'src/dangling.ts',
      redirected: false,
      reason: 'dangling',
    });
    await expect(resolveSessionFileProviderOpenPath(provider, 'src/external.ts')).resolves.toEqual({
      path: 'src/external.ts',
      redirected: false,
      reason: 'external',
    });
  });

  it('keeps cyclic symlinks on their metadata entry', async () => {
    const provider = createFakeSessionFileProvider({ files });

    await expect(resolveSessionFileProviderOpenPath(provider, 'src/cycle-a.ts')).resolves.toEqual({
      path: 'src/cycle-a.ts',
      redirected: false,
      reason: 'cycle',
    });
  });
});
