import { describe, expect, it } from 'vitest';
import {
  isDirectLocalProject,
  getLocalProjectHistoryCatalogKey,
  getExternalAcpHistoryImportKey,
} from '../src/project';
import {
  resolveResumableAcpSessionId,
  resolveSessionAcpTargetId,
} from '../src/session-acp-identity';
import type { SessionMeta } from '../src/schema';
import type { AgentConfigId } from '../src/ids';
import type { LocalProjectId } from '../src/project';

describe('isDirectLocalProject', () => {
  it('identifies local projects using their original shared directory', () => {
    expect(isDirectLocalProject({ kind: 'local' })).toBe(true);
    expect(isDirectLocalProject({ kind: 'local', useWorktree: false })).toBe(true);
  });

  it('preserves current and legacy local worktree sessions', () => {
    expect(isDirectLocalProject({ kind: 'local', useWorktree: true })).toBe(false);
    expect(isDirectLocalProject({ kind: 'local' }, true)).toBe(false);
  });

  it('does not classify GitHub or legacy project metadata as direct local', () => {
    expect(isDirectLocalProject({ kind: 'github' })).toBe(false);
    expect(isDirectLocalProject(undefined)).toBe(false);
  });
});

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
