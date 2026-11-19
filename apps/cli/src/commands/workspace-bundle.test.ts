import { describe, expect, it } from 'vitest';
import { formatImportPlan } from './workspace-bundle';

describe('formatImportPlan', () => {
  it('lists additions, deletions, skipped rooms and gaps in plain lines', () => {
    const text = formatImportPlan({
      digest: 'd'.repeat(64),
      sourceWorkspaceId: 'ws_a',
      targetWorkspaceId: 'ws_b',
      gaps: [{ id: 'session-r', kind: 'roost', reason: 'not supported' }],
      rooms: [
        {
          id: 'session-1',
          targetId: 'session-1',
          codec: 'session/v1',
          model: 'loro',
          action: 'merge',
          state: 'new',
        },
        {
          id: 'session-2',
          targetId: 'session-2',
          codec: 'session/v1',
          model: 'loro',
          action: 'merge',
          state: 'unchanged',
        },
        {
          id: 'session-3',
          targetId: 'session-3',
          codec: 'session/v1',
          model: 'loro',
          action: 'skip',
          reason: 'unrelated-same-id',
        },
        {
          id: 'ws_a:wf:workspace',
          targetId: 'ws_b:wf:workspace',
          codec: 'workspace-catalog/v1',
          model: 'flock',
          action: 'skip',
          reason: 'unauthorized',
          detail: "Changes another member's Agent Role r1",
        },
        {
          id: 'meta',
          targetId: 'meta',
          codec: 'meta/v1',
          model: 'meta',
          action: 'merge',
          state: 'merge',
          rows: { added: 3, updated: 1, deleted: 2 },
        },
      ],
    });
    expect(text).toContain('From workspace ws_a into ws_b');
    expect(text).toContain('1 new, 0 updated, 1 already up to date');
    expect(text).toContain('Metadata rows: 3 added, 1 updated, 2 deleted');
    expect(text).toContain('Skipped session-3: same ID, unrelated history');
    expect(text).toContain("Skipped ws_a:wf:workspace: Changes another member's Agent Role r1");
    expect(text).toContain('Not in this bundle: session-r (roost): not supported');
  });
});
