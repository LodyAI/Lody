import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  deriveRepoIdFromLocalProjectPath,
  SessionStatusFactory,
  type SessionMeta,
} from '@lody/shared';
import { resolveSessionLocalFileSource } from '../src/lib/session-local-file-source';
import { LOCAL_TEXT_PAGE_BYTES } from '@lody/shared/local-file-preview';
import { createLocalPagedFileSource } from '../src/lib/paged-file-source';

describe('session-local-file-source', () => {
  function createSession(overrides: Partial<SessionMeta>): SessionMeta {
    return {
      id: 'session-1',
      machineId: 'machine-local',
      createdAt: new Date().toISOString(),
      ...overrides,
    } as SessionMeta;
  }

  describe('resolveSessionLocalFileSource', () => {
    it('returns local-project source for same-machine local project sessions', () => {
      const source = resolveSessionLocalFileSource(
        createSession({
          machineId: 'machine-local',
          project: {
            kind: 'local',
            localProjectId: 'local-project-1',
            branch: 'main',
          } as SessionMeta['project'],
        }),
        {
          isElectronRenderer: true,
          localMachineId: 'machine-local',
          workspaceId: 'workspace-1',
        }
      );

      expect(source).toEqual({
        kind: 'local-project',
        workspaceId: 'workspace-1',
        localProjectId: 'local-project-1',
      });
    });

    it('returns session-worktree source for same-machine active github sessions', () => {
      const source = resolveSessionLocalFileSource(
        createSession({
          id: 'session-worktree-1',
          machineId: 'machine-local',
          project: {
            kind: 'github',
            repoFullName: 'loro-dev/lody',
            branch: 'main',
          } as SessionMeta['project'],
        }),
        {
          isElectronRenderer: true,
          localMachineId: 'machine-local',
          workspaceId: 'workspace-1',
        }
      );

      expect(source).toEqual({
        kind: 'session-worktree',
        repoKey: 'loro-dev/lody',
        sessionId: 'session-worktree-1',
      });
    });

    it('returns session-worktree source for same-machine active local worktree sessions', () => {
      const localProjectRootPath = '/Users/alice/code/app';
      const source = resolveSessionLocalFileSource(
        createSession({
          id: 'local-worktree-1',
          machineId: 'machine-local',
          project: {
            kind: 'local',
            localProjectId: 'local-project-1',
            branch: 'feature/base',
          } as SessionMeta['project'],
          isWorktree: true,
          status: SessionStatusFactory.running(),
          lastRunningSeen: Date.now(),
        }),
        {
          isElectronRenderer: true,
          localMachineId: 'machine-local',
          workspaceId: 'workspace-1',
          localProjectRootPath,
        }
      );

      expect(source).toEqual({
        kind: 'session-worktree',
        repoKey: deriveRepoIdFromLocalProjectPath(localProjectRootPath),
        sessionId: 'local-worktree-1',
      });
    });

    it('does not fall back to the main local project when a local worktree root is unavailable', () => {
      const source = resolveSessionLocalFileSource(
        createSession({
          id: 'local-worktree-1',
          machineId: 'machine-local',
          project: {
            kind: 'local',
            localProjectId: 'local-project-1',
            branch: 'feature/base',
          } as SessionMeta['project'],
          isWorktree: true,
          status: SessionStatusFactory.running(),
          lastRunningSeen: Date.now(),
        }),
        {
          isElectronRenderer: true,
          localMachineId: 'machine-local',
          workspaceId: 'workspace-1',
        }
      );

      expect(source).toBeNull();
    });

    it('uses the parent worktree for active child github sessions', () => {
      const source = resolveSessionLocalFileSource(
        createSession({
          id: 'child-session-1',
          parentSessionId: 'parent-session-1',
          machineId: 'machine-local',
          project: {
            kind: 'github',
            repoFullName: 'loro-dev/lody',
            branch: 'main',
          } as SessionMeta['project'],
          status: SessionStatusFactory.running(),
          lastRunningSeen: Date.now(),
        }),
        {
          isElectronRenderer: true,
          localMachineId: 'machine-local',
          workspaceId: 'workspace-1',
        }
      );

      expect(source).toEqual({
        kind: 'session-worktree',
        repoKey: 'loro-dev/lody',
        sessionId: 'parent-session-1',
      });
    });

    it('keeps github worktree source available after the session becomes idle', () => {
      const source = resolveSessionLocalFileSource(
        createSession({
          machineId: 'machine-local',
          project: {
            kind: 'github',
            repoFullName: 'loro-dev/lody',
            branch: 'main',
          } as SessionMeta['project'],
          status: SessionStatusFactory.idle(),
        }),
        {
          isElectronRenderer: true,
          localMachineId: 'machine-local',
          workspaceId: 'workspace-1',
        }
      );

      expect(source).toEqual({
        kind: 'session-worktree',
        repoKey: 'loro-dev/lody',
        sessionId: 'session-1',
      });
    });

    it('does not enable local source for remote machine sessions', () => {
      const source = resolveSessionLocalFileSource(
        createSession({
          machineId: 'machine-remote',
          project: {
            kind: 'local',
            localProjectId: 'local-project-remote',
            branch: 'main',
          } as SessionMeta['project'],
        }),
        {
          isElectronRenderer: true,
          localMachineId: 'machine-local',
          workspaceId: 'workspace-1',
        }
      );

      expect(source).toBeNull();
    });

    it('does not enable local project source without a workspace id', () => {
      const source = resolveSessionLocalFileSource(
        createSession({
          machineId: 'machine-local',
          project: {
            kind: 'local',
            localProjectId: 'local-project-1',
            branch: 'main',
          } as SessionMeta['project'],
        }),
        {
          isElectronRenderer: true,
          localMachineId: 'machine-local',
          workspaceId: null,
        }
      );

      expect(source).toBeNull();
    });
  });
});

describe('paged-file-source', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('local paged text', () => {
    it.each(['中', '😀', 'é'])(
      'preserves %s across every byte boundary without duplication',
      async (character) => {
        for (let overlap = 1; overlap < new TextEncoder().encode(character).length; overlap++) {
          const text = 'a'.repeat(LOCAL_TEXT_PAGE_BYTES - overlap) + character + 'end';
          const bytes = new TextEncoder().encode(text);
          vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
            const range = new Headers(options.headers).get('Range')!.match(/bytes=(\d+)-(\d+)/)!;
            return new Response(bytes.slice(Number(range[1]), Number(range[2]) + 1), {
              status: 206,
            });
          });
          const source = createLocalPagedFileSource('lody-resource://file/test', bytes.length);
          const signal = new AbortController().signal;
          expect((await source.readPage(0, signal)) + (await source.readPage(1, signal))).toBe(
            text
          );
        }
      }
    );

    it('refuses stale resources and invalid pages', async () => {
      vi.stubGlobal('fetch', async () => new Response(null, { status: 409 }));
      const source = createLocalPagedFileSource('lody-resource://file/test', 100);
      await expect(source.readPage(0, new AbortController().signal)).rejects.toThrow(
        'File changed'
      );
      await expect(source.readPage(1, new AbortController().signal)).rejects.toThrow(
        'Invalid page'
      );
    });
  });
});
