import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionTabRenamePatch,
  getSessionGroupTitle,
  getSessionRoomId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';

import type { Logger } from '@/utils/logger';
import { SessionDocument } from './doc';
import { composeTestSessionDoc } from '../../../tests/session-doc-fixture';

const createLogger = (): Logger =>
  ({
    debug: vi.fn(),
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

/** A session whose doc meta lives in an in-memory replica, so tests read resulting state. */
const createTitledSession = (initial: Partial<SessionMeta>) => {
  const sessionId = 'title-session' as SessionId;
  const roomId = getSessionRoomId(sessionId);
  let meta: Partial<SessionMeta> = { id: sessionId, ...initial };
  const repo: Partial<LoroRepo> = {
    getDocMeta: vi.fn(async (id: string) => (id === roomId ? { meta } : undefined)) as never,
    upsertDocMeta: vi.fn(async (id: string, patch: Partial<SessionMeta>) => {
      if (id === roomId) meta = { ...meta, ...patch };
    }) as never,
  };
  const doc = new SessionDocument(repo as LoroRepo, sessionId, async () => {}, createLogger());
  composeTestSessionDoc(doc);
  return {
    doc,
    meta: () => meta,
    rename: (title: string) => {
      meta = { ...meta, ...buildSessionTabRenamePatch(meta, title) };
    },
  };
};

const generate = (doc: SessionDocument, title: string) =>
  doc.setTitleIfSourceIn(title, 'generated', ['draft', 'generated']);

describe('SessionDocument group titles', () => {
  it('copies the first generated root title into the group exactly once', async () => {
    const session = createTitledSession({ title: 'fix the login', titleSource: 'draft' });
    expect(getSessionGroupTitle(session.meta())).toBe('fix the login');

    await expect(generate(session.doc, 'Fix login redirect')).resolves.toBe(true);
    expect(session.meta()).toMatchObject({
      title: 'Fix login redirect',
      groupTitle: 'Fix login redirect',
      groupTitleSource: 'generated',
    });

    // A later agent-pushed title still renames the tab, never the sidebar group.
    await expect(generate(session.doc, 'Login redirect follow-up')).resolves.toBe(true);
    expect(session.meta()).toMatchObject({
      title: 'Login redirect follow-up',
      groupTitle: 'Fix login redirect',
    });
  });

  it('names a draft group when the root tab was renamed before generation finished', async () => {
    const session = createTitledSession({ title: 'fix the login', titleSource: 'draft' });
    session.rename('My tab');
    expect(getSessionGroupTitle(session.meta())).toBe('fix the login');

    await expect(generate(session.doc, 'Fix login redirect')).resolves.toBe(false);
    expect(session.meta()).toMatchObject({
      title: 'My tab',
      titleSource: 'user',
      groupTitle: 'Fix login redirect',
      groupTitleSource: 'generated',
    });
  });

  it('keeps a legacy user title as the sidebar name when an agent title arrives', async () => {
    const session = createTitledSession({ title: 'Renamed long ago', titleSource: 'user' });

    await expect(generate(session.doc, 'Agent title')).resolves.toBe(false);
    expect(session.meta()).not.toHaveProperty('groupTitle');
    expect(getSessionGroupTitle(session.meta())).toBe('Renamed long ago');
  });

  it('never gives a child tab a group title', async () => {
    const session = createTitledSession({
      title: 'child draft',
      titleSource: 'draft',
      parentSessionId: 'root-session' as SessionId,
    });

    await expect(generate(session.doc, 'Child title')).resolves.toBe(true);
    expect(session.meta()).toMatchObject({ title: 'Child title' });
    expect(session.meta()).not.toHaveProperty('groupTitle');
  });
});
