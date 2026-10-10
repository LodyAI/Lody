import { Duration, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'vitest';
import { deriveLodyConnectionUiState } from '../src/atoms/control-connection';
import {
  computeLocalReconnectDelayMs,
  waitForLocalReconnectDelayEffect,
} from '../src/providers/create-workspace-runtime';
import { resolveWorkspaceControlConnectionState } from '../src/providers/control-connection-state';

describe('deriveLodyConnectionUiState', () => {
  it('treats a synced runtime as online', () => {
    expect(
      deriveLodyConnectionUiState({
        state: 'online',
        runtimeInitializing: false,
        browserOnline: true,
      })
    ).toBe('online');
  });

  it('keeps startup in loading before initial sync completes', () => {
    expect(
      deriveLodyConnectionUiState({
        state: 'syncing',
        runtimeInitializing: true,
        browserOnline: true,
      })
    ).toBe('loading');
  });

  it('surfaces reconnecting once a previously-synced runtime drops', () => {
    expect(
      deriveLodyConnectionUiState({
        state: 'reconnecting',
        runtimeInitializing: false,
        browserOnline: true,
      })
    ).toBe('reconnecting');
  });

  it('prioritizes browser offline over reconnecting UI', () => {
    expect(
      deriveLodyConnectionUiState({
        state: 'reconnecting',
        runtimeInitializing: false,
        browserOnline: false,
      })
    ).toBe('offline');
  });

  it('shows loading when idle and browser is online (token not yet set)', () => {
    expect(
      deriveLodyConnectionUiState({
        state: 'idle',
        runtimeInitializing: false,
        browserOnline: true,
      })
    ).toBe('loading');
  });

  it('shows loading when idle during runtime initialization', () => {
    expect(
      deriveLodyConnectionUiState({
        state: 'idle',
        runtimeInitializing: true,
        browserOnline: true,
      })
    ).toBe('loading');
  });

  it('shows offline when idle and browser is offline', () => {
    expect(
      deriveLodyConnectionUiState({
        state: 'idle',
        runtimeInitializing: false,
        browserOnline: false,
      })
    ).toBe('offline');
  });

  it('shows offline when runtime reports local offline', () => {
    expect(
      deriveLodyConnectionUiState({
        state: 'offline',
        runtimeInitializing: false,
        browserOnline: true,
      })
    ).toBe('offline');
  });
});

describe('computeLocalReconnectDelayMs', () => {
  it('uses exponential backoff with jitter', () => {
    expect(computeLocalReconnectDelayMs(0, () => 0.5)).toBe(1000);
    expect(computeLocalReconnectDelayMs(1, () => 0.5)).toBe(2000);
    expect(computeLocalReconnectDelayMs(2, () => 0)).toBe(3200);
    expect(computeLocalReconnectDelayMs(2, () => 1)).toBe(4800);
  });

  it('caps delay at 30 seconds after jitter', () => {
    expect(computeLocalReconnectDelayMs(20, () => 1)).toBe(30000);
  });

  it('waits for the computed backoff delay with TestClock', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          waitForLocalReconnectDelayEffect({ attempt: 2, random: () => 0.5 })
        );

        yield* TestClock.adjust(Duration.millis(4_000));

        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer()))
    );

    expect(result).toBe(4000);
  });
});

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

  it('keeps the workspace online while the meta room is synced', () => {
    expect(
      resolveWorkspaceControlConnectionState({
        hasAuthToken: true,
        browserOnline: true,
        transportAttached: true,
        metaSyncState: 'synced',
        initialMetaSyncCompleted: true,
        initialMetaSyncFailed: false,
      })
    ).toBe('online');
  });

  it('reports reconnecting when the synced meta room drops after initial sync', () => {
    expect(
      resolveWorkspaceControlConnectionState({
        hasAuthToken: true,
        browserOnline: true,
        transportAttached: true,
        metaSyncState: 'reconnecting',
        initialMetaSyncCompleted: true,
        initialMetaSyncFailed: false,
      })
    ).toBe('reconnecting');
  });

  it('reports syncing while the meta room is joined but initial sync is pending', () => {
    expect(
      resolveWorkspaceControlConnectionState({
        hasAuthToken: true,
        browserOnline: true,
        transportAttached: true,
        metaSyncState: 'syncing',
        initialMetaSyncCompleted: false,
        initialMetaSyncFailed: false,
      })
    ).toBe('syncing');
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

  it('reports connecting while the fresh meta room is still joining', () => {
    expect(
      resolveWorkspaceControlConnectionState({
        hasAuthToken: true,
        browserOnline: true,
        transportAttached: true,
        metaSyncState: 'connecting',
        initialMetaSyncCompleted: false,
        initialMetaSyncFailed: false,
      })
    ).toBe('connecting');
  });
});
