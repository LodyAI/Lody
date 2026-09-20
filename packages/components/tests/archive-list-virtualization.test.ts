import { describe, expect, it } from 'vitest';
import type { SessionId, SessionMeta } from '@lody/shared';
import {
  ARCHIVE_DESKTOP_SESSION_ROW_ESTIMATE_PX,
  ARCHIVE_GROUP_GAP_PX,
  ARCHIVE_HEADER_ROW_ESTIMATE_PX,
  ARCHIVE_LIST_VIRTUALIZE_THRESHOLD,
  archiveRowDataId,
  estimateArchiveRowSize,
  flattenVisibleArchiveRows,
  shouldVirtualizeVisibleArchiveRows,
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
  it('virtualizes based on visible row count, not collapsed contents', () => {
    expect(shouldVirtualizeVisibleArchiveRows(ARCHIVE_LIST_VIRTUALIZE_THRESHOLD)).toBe(false);
    expect(shouldVirtualizeVisibleArchiveRows(ARCHIVE_LIST_VIRTUALIZE_THRESHOLD + 1)).toBe(true);
  });

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

  it('marks local project headers for the taller estimate', () => {
    const rows = flattenVisibleArchiveRows(
      [group('local:m:p', [session('a')], { kind: 'local' })],
      { hideGroupHeader: false }
    );
    expect(rows[0]).toMatchObject({ kind: 'header', local: true });
    expect(estimateArchiveRowSize(rows[0], { isMobile: false })).toBeGreaterThan(
      ARCHIVE_HEADER_ROW_ESTIMATE_PX
    );
  });

  it('adds group gap to trailing rows so the spacer matches section spacing', () => {
    const rows = flattenVisibleArchiveRows([group('acme/app', [session('last')])], {
      hideGroupHeader: false,
    });
    const sessionRow = rows[1];
    expect(sessionRow?.kind).toBe('session');
    expect(estimateArchiveRowSize(sessionRow, { isMobile: false })).toBe(
      ARCHIVE_DESKTOP_SESSION_ROW_ESTIMATE_PX + ARCHIVE_GROUP_GAP_PX
    );
  });
});

function rowExtra(row: ReturnType<typeof flattenVisibleArchiveRows>[number]) {
  if (row.kind === 'header') {
    return { isFirst: row.isFirst, isLastInGroup: row.isLastInGroup };
  }
  return { depth: row.depth, isLastInGroup: row.isLastInGroup };
}
