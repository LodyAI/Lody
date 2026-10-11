import { describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { createLoroSessionData } from '@lody/shared/session-data';
import { createConversationSession } from '../src/lib/conversation-view/create-conversation-session';

describe('createConversationSession backend seam', () => {
  it('uses the injected SessionData factory and forwards the backend kind', () => {
    const doc = new LoroDoc();
    const createSessionData = vi.fn(({ sessionId, doc: sessionDoc, writer }) =>
      createLoroSessionData({ sessionId, doc: sessionDoc, writer })
    );

    const session = createConversationSession(doc, {
      sessionId: 'session-1' as never,
      backendKind: 'roost',
      createSessionData,
      scheduleIdle: () => () => {},
    });

    expect(createSessionData).toHaveBeenCalledWith({
      sessionId: 'session-1',
      doc,
      backendKind: 'roost',
      writer: undefined,
    });
    expect(session.sessionData.sessionId).toBe('session-1');
    session.dispose();
  });

  it('fails closed when Roost metadata has no renderer factory', () => {
    expect(() =>
      createConversationSession(new LoroDoc(), {
        sessionId: 'session-1' as never,
        backendKind: 'roost',
        scheduleIdle: () => () => {},
      })
    ).toThrow(/requires a renderer SessionData factory/);
  });

  it('keeps the default Loro composition when no factory is supplied', () => {
    const session = createConversationSession(new LoroDoc(), {
      sessionId: 'session-1' as never,
      scheduleIdle: () => () => {},
    });

    expect(session.sessionData.sessionId).toBe('session-1');
    session.dispose();
  });
});
