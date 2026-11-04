import { describe, expect, it } from 'vitest';

import type { MachineId, SessionId } from '../src/ai';
import { buildInitialHistoryEntry, buildInitialSessionMetaPatch } from '../src/session-bootstrap';

describe('session bootstrap helpers', () => {
  it('returns null when there is no effective initial user input', () => {
    const entry = buildInitialHistoryEntry({
      userId: 'user-1',
      timestamp: '2026-04-19T00:00:00.000Z',
      cliType: 'builtin',
      agentType: 'codex',
      prompt: '   ',
      inputBlocks: [{ type: 'text', text: '   ' }],
    });

    expect(entry).toBeNull();
  });

  it('does not persist an unresolved local branch selector as baseBranch', () => {
    const patch = buildInitialSessionMetaPatch({
      sessionId: 'session-local' as SessionId,
      machineId: 'machine-1' as MachineId,
      userId: 'user-1',
      cliType: 'builtin',
      agentType: 'codex',
      createdAt: '2026-08-02T00:00:00.000Z',
      project: {
        kind: 'local',
        localProjectId: 'project-1' as never,
        branch: 'lody:branch:remote:origin:foo',
        useWorktree: true,
      },
    });

    expect(patch.project).toMatchObject({ branch: 'lody:branch:remote:origin:foo' });
    expect(patch).not.toHaveProperty('baseBranch');
  });
});
