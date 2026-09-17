import { describe, expect, it } from 'vitest';
import type { SessionId } from '@lody/shared';
import {
  getSessionNavigationLocation,
  resolveCurrentWorkspaceTabNavigation,
  resolveSessionTabRestoreNavigation,
  resolveOpenedByNavigationTarget,
} from '../src/lib/session-navigation';

const sessionId = (value: string) => value as SessionId;

describe('resolveOpenedByNavigationTarget', () => {
  it('returns the root Session when the opener is already a root', () => {
    expect(
      resolveOpenedByNavigationTarget(
        { openedBySessionId: sessionId('root-session') },
        {
          metadataReady: true,
          openerSession: { id: sessionId('root-session') },
          rootSession: { id: sessionId('root-session') },
        }
      )
    ).toEqual({ sessionId: 'root-session' });
  });

  it('restores the exact opener Tab from persisted relationship metadata', () => {
    expect(
      resolveOpenedByNavigationTarget(
        {
          openedBySessionId: sessionId('child-tab'),
          openedByRootSessionId: sessionId('root-session'),
        },
        {
          metadataReady: true,
          openerSession: {
            id: sessionId('child-tab'),
            parentSessionId: sessionId('root-session'),
          },
          rootSession: { id: sessionId('root-session') },
        }
      )
    ).toEqual({ sessionId: 'root-session', tabSessionId: 'child-tab' });
  });

  it('resolves legacy child-Tab relationships from the opener metadata', () => {
    expect(
      resolveOpenedByNavigationTarget(
        { openedBySessionId: sessionId('child-tab') },
        {
          metadataReady: true,
          openerSession: {
            id: sessionId('child-tab'),
            parentSessionId: sessionId('root-session'),
          },
          rootSession: { id: sessionId('root-session') },
        }
      )
    ).toEqual({ sessionId: 'root-session', tabSessionId: 'child-tab' });
  });

  it('withholds navigation until metadata hydration can prove the target exists', () => {
    expect(
      resolveOpenedByNavigationTarget(
        { openedBySessionId: sessionId('root-session') },
        {
          metadataReady: false,
          openerSession: { id: sessionId('root-session') },
          rootSession: { id: sessionId('root-session') },
        }
      )
    ).toBeNull();
  });

  it('keeps dangling provenance non-navigable when the opener was deleted', () => {
    expect(
      resolveOpenedByNavigationTarget(
        {
          openedBySessionId: sessionId('child-tab'),
          openedByRootSessionId: sessionId('root-session'),
        },
        { metadataReady: true, openerSession: null, rootSession: null }
      )
    ).toBeNull();
  });

  it('withholds child-Tab navigation when its route root no longer exists', () => {
    expect(
      resolveOpenedByNavigationTarget(
        {
          openedBySessionId: sessionId('child-tab'),
          openedByRootSessionId: sessionId('root-session'),
        },
        {
          metadataReady: true,
          openerSession: {
            id: sessionId('child-tab'),
            parentSessionId: sessionId('root-session'),
          },
          rootSession: null,
        }
      )
    ).toBeNull();
  });
});

describe('getSessionNavigationLocation', () => {
  it('encodes the exact Tab in the root Session route', () => {
    expect(
      getSessionNavigationLocation({
        sessionId: sessionId('root-session'),
        tabSessionId: sessionId('child-tab'),
      })
    ).toEqual({ sessionId: 'root-session', tab: 'session:child-tab' });
  });

  it('omits the tab search for a root Session target', () => {
    expect(getSessionNavigationLocation({ sessionId: sessionId('root-session') })).toEqual({
      sessionId: 'root-session',
      tab: undefined,
    });
  });
});

describe('resolveCurrentWorkspaceTabNavigation', () => {
  const currentTabs = new Set(['root-session', 'open-child', 'closed-child']);
  const closedTabs = new Set(['closed-child']);

  it('reopens a closed child targeted by its created Session card', () => {
    expect(
      resolveCurrentWorkspaceTabNavigation(
        { sessionId: sessionId('closed-child') },
        sessionId('root-session'),
        currentTabs,
        closedTabs
      )
    ).toEqual({ tabSessionId: 'closed-child', shouldReopen: true });
  });

  it('selects an open explicit root-and-tab navigation target without restoring it', () => {
    expect(
      resolveCurrentWorkspaceTabNavigation(
        {
          sessionId: sessionId('root-session'),
          tabSessionId: sessionId('open-child'),
        },
        sessionId('root-session'),
        currentTabs,
        closedTabs
      )
    ).toEqual({ tabSessionId: 'open-child', shouldReopen: false });
  });

  it('leaves an unrelated Session to route navigation', () => {
    expect(
      resolveCurrentWorkspaceTabNavigation(
        { sessionId: sessionId('other-session') },
        sessionId('root-session'),
        currentTabs,
        closedTabs
      )
    ).toBeNull();
  });
});

describe('resolveSessionTabRestoreNavigation', () => {
  const closedTabs = new Set(['child-c']);

  it('waits for the exact closed child instead of falling back to open siblings', () => {
    expect(
      resolveSessionTabRestoreNavigation(
        sessionId('child-c'),
        sessionId('root-session'),
        sessionId('root-session'),
        'session:child-b',
        'session:child-b',
        true,
        closedTabs
      )
    ).toEqual({ kind: 'wait' });
  });

  it('selects the exact restored child after its open state is projected', () => {
    expect(
      resolveSessionTabRestoreNavigation(
        sessionId('child-c'),
        sessionId('root-session'),
        sessionId('root-session'),
        'session:child-b',
        'session:child-b',
        true,
        new Set()
      )
    ).toEqual({ kind: 'navigate', tabSessionId: 'child-c' });
  });

  it('does not override a newer user navigation while the restore is pending', () => {
    expect(
      resolveSessionTabRestoreNavigation(
        sessionId('child-c'),
        sessionId('root-session'),
        sessionId('root-session'),
        'session:child-b',
        'session:child-a',
        true,
        new Set()
      )
    ).toEqual({ kind: 'cancel' });
  });

  it('cancels a delayed restore across tabless Session routes', () => {
    expect(
      resolveSessionTabRestoreNavigation(
        sessionId('child-c'),
        sessionId('session-a'),
        sessionId('session-b'),
        undefined,
        undefined,
        true,
        new Set()
      )
    ).toEqual({ kind: 'cancel' });
  });
});
