import { describe, expect, it } from 'vitest';

import { resolveWorkspaceControlConnectionState } from '../src/providers/control-connection-state';

describe('resolveWorkspaceControlConnectionState', () => {
  it('reports local browser offline before reconnecting', () => {
    expect(
      resolveWorkspaceControlConnectionState({
        hasAuthToken: true,
        browserOnline: false,
        transportAttached: true,
        metaSyncState: 'reconnecting',
        initialMetaSyncCompleted: true,
        initialMetaSyncFailed: false,
      })
    ).toBe('offline');
  });

  it('reports reconnecting when initial meta sync fails before the room joins', () => {
    expect(
      resolveWorkspaceControlConnectionState({
        hasAuthToken: true,
        browserOnline: true,
        transportAttached: true,
        metaSyncState: 'connecting',
        initialMetaSyncCompleted: false,
        initialMetaSyncFailed: true,
      })
    ).toBe('reconnecting');
  });

  it('reports reconnecting when the meta room is terminally dead after having synced', () => {
    expect(
      resolveWorkspaceControlConnectionState({
        hasAuthToken: true,
        browserOnline: true,
        transportAttached: true,
        metaSyncState: 'disconnected',
        initialMetaSyncCompleted: true,
        initialMetaSyncFailed: false,
      })
    ).toBe('reconnecting');
  });
});
