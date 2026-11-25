import { describe, expect, it } from 'vitest';
import {
  getLocalProjectHistoryCatalogKey,
  getExternalAcpHistoryImportKey,
  isWorktreeSessionMeta,
} from '../src/project';
import {
  resolveResumableAcpSessionId,
  resolveSessionAcpTargetId,
} from '../src/session-acp-identity';
import type { SessionMeta } from '../src/schema';
import type { AgentConfigId } from '../src/ids';
import type { LocalProjectId } from '../src/project';

describe('imported ACP session identity', () => {
  const source = 'import-source';
  const imported = {
    externalHistory: { sourceAcpSessionId: source, status: 'synced' },
  } as SessionMeta;
  it('addresses an imported source without claiming it is a Lody-owned runtime', () => {
    expect(resolveSessionAcpTargetId(imported)).toBe(source);
    expect(resolveResumableAcpSessionId(imported)).toBeUndefined();
    const legacy = { ...imported, acpSessionId: source } as SessionMeta;
    expect(resolveSessionAcpTargetId(legacy)).toBe(source);
    expect(resolveResumableAcpSessionId(legacy)).toBeUndefined();
  });
  it('refuses a conflicted source but preserves a newer owned runtime', () => {
    const conflict = {
      ...imported,
      externalHistory: { ...imported.externalHistory!, status: 'sync_conflict' },
    } as SessionMeta;
    expect(resolveSessionAcpTargetId(conflict)).toBeUndefined();
    const continued = { ...conflict, acpSessionId: 'owned-runtime' } as SessionMeta;
    expect(resolveSessionAcpTargetId(continued)).toBe('owned-runtime');
    expect(resolveResumableAcpSessionId(continued)).toBe('owned-runtime');
    expect(resolveSessionAcpTargetId(undefined)).toBeUndefined();
  });
  it('separates account catalogs without changing legacy transcript/import identifiers', () => {
    const family = { cliType: 'builtin', agentType: 'codex' } as const;
    const a = { ...family, agentConfigId: 'a' as AgentConfigId };
    const b = { ...family, agentConfigId: 'b' as AgentConfigId };
    expect(getLocalProjectHistoryCatalogKey(a)).not.toBe(getLocalProjectHistoryCatalogKey(b));
    const key = (provider: typeof a | typeof family) =>
      getExternalAcpHistoryImportKey({
        machineId: 'm',
        localProjectId: 'p' as LocalProjectId,
        provider,
        sourceAcpSessionId: source,
      });
    expect(key(a)).toBe(key(family));
  });
});

describe('isWorktreeSessionMeta', () => {
  const localProjectId = 'local-proj' as LocalProjectId;

  it('classifies direct local projects (even with a GitHub remote) and plain chats as non-worktree', () => {
    expect(isWorktreeSessionMeta(undefined)).toBe(false);
    expect(isWorktreeSessionMeta(null)).toBe(false);
    expect(isWorktreeSessionMeta({})).toBe(false);
    expect(
      isWorktreeSessionMeta({
        project: {
          kind: 'local',
          localProjectId,
          branch: 'main',
          githubRepoFullName: 'lodyai/lody',
          useWorktree: false,
        },
        repoFullName: 'lodyai/lody',
      })
    ).toBe(false);
    expect(
      isWorktreeSessionMeta({
        project: { kind: 'local', localProjectId },
        repoFullName: 'lodyai/lody',
        isWorktree: false,
      })
    ).toBe(false);
  });

  it('classifies GitHub sessions, local worktree sessions, and legacy repo sessions as worktree', () => {
    expect(
      isWorktreeSessionMeta({
        project: { kind: 'github', repoFullName: 'lodyai/lody', branch: 'main' },
      })
    ).toBe(true);
    expect(
      isWorktreeSessionMeta({
        project: { kind: 'local', localProjectId, useWorktree: true },
      })
    ).toBe(true);
    expect(
      isWorktreeSessionMeta({
        project: { kind: 'local', localProjectId },
        isWorktree: true,
      })
    ).toBe(true);
    expect(isWorktreeSessionMeta({ repoFullName: 'lodyai/lody' })).toBe(true);
    expect(isWorktreeSessionMeta({ isWorktree: true })).toBe(true);
  });

  it('checks projectRun members rather than relying on the first-member compatibility flag', () => {
    expect(
      isWorktreeSessionMeta({
        isWorktree: false,
        project: { kind: 'local', localProjectId, useWorktree: false },
        projectRun: {
          members: {
            docs: { access: 'additional' },
            app: { access: 'worktree' },
          },
        },
      })
    ).toBe(true);
    expect(
      isWorktreeSessionMeta({
        isWorktree: false,
        projectRun: {
          members: {
            docs: { access: 'additional' },
            notes: { access: 'link' },
          },
        },
      })
    ).toBe(false);
  });
});
