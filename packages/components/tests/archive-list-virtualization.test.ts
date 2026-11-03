import { describe, expect, it } from 'vitest';
import type { SessionId, SessionMeta } from '@lody/shared';
import {
  archiveRowDataId,
  flattenVisibleArchiveRows,
  type ArchiveListGroupInput,
} from '../src/lib/archive-list-virtualization';

function session(id: string, relations: Partial<SessionMeta> = {}): SessionMeta {
  return { id: id as SessionId, title: id, ...relations } as SessionMeta;
}

function group(
  key: string,
  sessions: SessionMeta[],
  extra: Partial<ArchiveListGroupInput> = {}
): ArchiveListGroupInput {
  return {
    key,
    kind: extra.kind ?? 'repo',
    collapsed: extra.collapsed ?? false,
    sessions,
  };
}

describe('archive list virtualization helpers', () => {
  it('flattens project groups into headers plus opened-by session rows', () => {
    const root = session('root');
    const opened = session('opened', { openedBySessionId: root.id });
    const rows = flattenVisibleArchiveRows(
      [
        group('acme/app', [opened, root, session('other')]),
        group('__chats__', [session('chat-1')], { kind: 'chat' }),
      ],
      { hideGroupHeader: false }
    );

    expect(rows.map((row) => ({ kind: row.kind, key: row.key, extra: rowExtra(row) }))).toEqual([
      { kind: 'header', key: 'header:acme/app', extra: { isFirst: true, isLastInGroup: false } },
      { kind: 'session', key: 'session:root', extra: { depth: 0, isLastInGroup: false } },
      { kind: 'session', key: 'session:opened', extra: { depth: 1, isLastInGroup: false } },
      { kind: 'session', key: 'session:other', extra: { depth: 0, isLastInGroup: true } },
      { kind: 'header', key: 'header:__chats__', extra: { isFirst: false, isLastInGroup: false } },
      { kind: 'session', key: 'session:chat-1', extra: { depth: 0, isLastInGroup: true } },
    ]);
    expect(archiveRowDataId(rows[0]!)).toBe('archive-group:acme/app');
    expect(archiveRowDataId(rows[1]!)).toBe('archive-session:root');
  });

  it('omits sessions of collapsed groups but keeps the header', () => {
    const rows = flattenVisibleArchiveRows(
      [
        group('acme/app', [session('a'), session('b')], { collapsed: true }),
        group('other/app', [session('c')]),
      ],
      { hideGroupHeader: false }
    );

    expect(rows.map((row) => row.key)).toEqual([
      'header:acme/app',
      'header:other/app',
      'session:c',
    ]);
    expect(rows[0]).toMatchObject({ kind: 'header', isFirst: true, isLastInGroup: true });
  });

  it('hides group headers in the flat list', () => {
    const rows = flattenVisibleArchiveRows(
      [group('__all__', [session('a'), session('b')], { kind: 'chat' })],
      { hideGroupHeader: true }
    );
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'session', sessionId: 'a', isLastInGroup: false }),
      expect.objectContaining({ kind: 'session', sessionId: 'b', isLastInGroup: true }),
    ]);
  });
});

function rowExtra(row: ReturnType<typeof flattenVisibleArchiveRows>[number]) {
  if (row.kind === 'header') {
    return { isFirst: row.isFirst, isLastInGroup: row.isLastInGroup };
  }
  return { depth: row.depth, isLastInGroup: row.isLastInGroup };
}
