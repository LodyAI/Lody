import { describe, expect, it } from 'vitest';
import type { MachineId, SessionId, SessionMeta } from '@lody/shared';

import {
  buildSessionRelationTree,
  countSessionRelationTree,
  hasSessionRelations,
  type SessionRelationTreeNode,
} from '../src/lib/session-relation-tree';

let clock = 0;
const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  id: id as SessionId,
  machineId: 'machine-1' as MachineId,
  createdAt: `2026-09-25T00:00:${String(clock++).padStart(2, '0')}.000Z`,
  userId: 'user-1',
  cliType: 'builtin',
  agentType: 'codex',
  ...extra,
});
const sid = (id: string) => id as SessionId;

/** `root[tab,tab]` with children indented by two spaces per depth. */
const outline = (node: SessionRelationTreeNode | null, depth = 0): string[] =>
  node
    ? [
        `${'  '.repeat(depth)}${node.session.id}${node.tabs.length ? `[${node.tabs.map((tab) => tab.id).join(',')}]` : ''}`,
        ...node.children.flatMap((child) => outline(child, depth + 1)),
      ]
    : [];

describe('buildSessionRelationTree', () => {
  // top ─ mid[tab] ─ leaf     (leaf opened from mid's Tab)
  //     └ sibling
  const sessions = [
    meta('top'),
    meta('mid', { openedBySessionId: sid('top') }),
    meta('tab', { parentSessionId: sid('mid'), openedBySessionId: sid('mid') }),
    meta('leaf', { openedBySessionId: sid('tab'), openedByRootSessionId: sid('mid') }),
    meta('sibling', { openedBySessionId: sid('top') }),
    meta('unrelated'),
  ];

  it('roots the complete tree at the topmost ancestor from anywhere inside it', () => {
    const expected = ['top', '  mid[tab]', '    leaf', '  sibling'];
    // Metadata-cache order is arbitrary; creation time decides row and Tab order.
    const shuffled = [...sessions].reverse();
    for (const current of ['top', 'mid', 'tab', 'leaf', 'sibling']) {
      expect(outline(buildSessionRelationTree(shuffled, sid(current)))).toEqual(expected);
    }
  });

  it('keeps an unrelated Session as a lone row without relations', () => {
    const tree = buildSessionRelationTree(sessions, sid('unrelated'));
    expect(outline(tree)).toEqual(['unrelated']);
    expect(hasSessionRelations(tree)).toBe(false);
    expect(hasSessionRelations(buildSessionRelationTree(sessions, sid('leaf')))).toBe(true);
    expect(countSessionRelationTree(buildSessionRelationTree(sessions, sid('top'))!)).toBe(5);
  });

  it('counts a Tab created in the same row as a relation', () => {
    const tree = buildSessionRelationTree(
      [
        meta('solo'),
        meta('mcp-tab', { parentSessionId: sid('solo'), openedBySessionId: sid('solo') }),
      ],
      sid('solo')
    );
    expect(outline(tree)).toEqual(['solo[mcp-tab]']);
    expect(hasSessionRelations(tree)).toBe(true);
  });

  it('drops archived rows and side chats, and stops the upward walk at an archived opener', () => {
    const tree = buildSessionRelationTree(
      [
        meta('gone', { isArchived: true }),
        meta('a', { openedBySessionId: sid('gone') }),
        meta('b', { openedBySessionId: sid('a') }),
        meta('b-archived', { openedBySessionId: sid('a'), isArchived: true }),
        meta('side', { parentSessionId: sid('a'), childSessionPlacement: 'side-panel' }),
      ],
      sid('b')
    );
    expect(outline(tree)).toEqual(['a', '  b']);
  });

  it('hides closed Tabs unless current, while rows opened from them still attach', () => {
    const tree = buildSessionRelationTree(
      [
        meta('root'),
        meta('closed', { parentSessionId: sid('root'), isTabClosed: true }),
        meta('closed-current', { parentSessionId: sid('root'), isTabClosed: true }),
        meta('opened', { openedBySessionId: sid('closed') }),
      ],
      sid('closed-current')
    );
    expect(outline(tree)).toEqual(['root[closed-current]', '  opened']);
  });

  it('terminates on an opened-by cycle and a self-opener', () => {
    const tree = buildSessionRelationTree(
      [meta('x', { openedBySessionId: sid('y') }), meta('y', { openedBySessionId: sid('x') })],
      sid('x')
    );
    expect(outline(tree)).toEqual(['y', '  x']);
    const self = buildSessionRelationTree(
      [meta('self', { openedBySessionId: sid('self') })],
      sid('self')
    );
    expect(outline(self)).toEqual(['self']);
    expect(hasSessionRelations(self)).toBe(false);
  });
});
