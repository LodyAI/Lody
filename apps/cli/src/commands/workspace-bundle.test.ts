import { describe, expect, it } from 'vitest';
import type { RoomPlan } from '@/lib/workspace-bundle/import';
import { formatImportPlan } from './workspace-bundle';

const room = (fields: Partial<RoomPlan> & Pick<RoomPlan, 'id' | 'action'>): RoomPlan => ({
  targetId: fields.id,
  codec: 'session/v1',
  model: 'loro',
  kind: 'conversations',
  counted: true,
  ...fields,
});

describe('formatImportPlan', () => {
  it('summarizes by kind and names skipped items instead of storage ids', () => {
    const text = formatImportPlan({
      digest: 'd'.repeat(64),
      sourceWorkspaceId: 'ws_a',
      targetWorkspaceId: 'ws_b',
      gaps: [{ id: 'session-r', kind: 'roost', reason: 'not supported' }],
      rooms: [
        room({ id: 'session-1', action: 'merge', state: 'new', label: 'Fix login' }),
        room({ id: 'session-2', action: 'merge', state: 'unchanged' }),
        room({
          id: 'session-3',
          action: 'skip',
          reason: 'unrelated-same-id',
          label: 'Release notes',
        }),
        room({
          id: 'ws_a:wf:workspace',
          codec: 'workspace-catalog/v1',
          model: 'flock',
          kind: 'catalog',
          action: 'skip',
          reason: 'unauthorized',
          detail: "Changes another member's Agent Role r1",
        }),
        room({
          id: 'meta',
          codec: 'meta/v1',
          model: 'meta',
          kind: 'other',
          counted: false,
          action: 'merge',
          state: 'merge',
        }),
      ],
    });
    expect(text).toContain('From workspace ws_a into ws_b');
    expect(text).toContain('Conversations: 1 new, 1 already here, 1 skipped');
    expect(text).toContain('Skipped "Release notes" (conversations): same ID, unrelated history');
    expect(text).toContain(
      "Skipped projects, Agent Roles and MCP: Changes another member's Agent Role r1"
    );
    expect(text).toContain('Not in this bundle: session-r (roost): not supported');
    expect(text).not.toContain('session-3');
    expect(text).not.toContain('Metadata');
  });
});
