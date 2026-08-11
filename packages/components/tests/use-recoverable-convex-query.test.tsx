/** @vitest-environment jsdom */

import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import { CONVEX_AUTH_ERROR_CODE, CONVEX_AUTH_ERROR_KIND } from '@lody/shared';
import {
  AuthenticatedConvexContext,
  type AuthenticatedConvexContextValue,
} from '../src/hooks/use-authenticated-convex';
import { useRecoverableConvexQuery } from '../src/hooks/use-recoverable-convex-query';
import { ErrorBoundary } from '../src/components/error-boundary';

const mocks = vi.hoisted(() => ({
  queryResult: undefined as unknown,
}));

vi.mock('convex/react', () => ({
  useQueries: (queries: Record<string, unknown>) =>
    Object.keys(queries).length === 0 ? {} : { query: mocks.queryResult },
}));

const query = makeFunctionReference<'query', { id: string }, { label: string }>('test:get');

function unauthenticatedError(): Error {
  return new ConvexError({
    kind: CONVEX_AUTH_ERROR_KIND,
    code: CONVEX_AUTH_ERROR_CODE.unauthenticated,
  });
}

class TestErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo) {}

  override render() {
    return this.state.error ? <div>ordinary fallback</div> : this.props.children;
  }
}

describe('useRecoverableConvexQuery', () => {
  let container: HTMLDivElement;
  let root: Root;
  let context: AuthenticatedConvexContextValue;
  let mounts: number;
  let unmounts: number;
  const requestAuthRecovery = vi.fn();

  function Consumer({ id = 'project-1', skip = false }: { id?: string; skip?: boolean }) {
    useEffect(() => {
      mounts += 1;
      return () => {
        unmounts += 1;
      };
    }, []);
    const result = useRecoverableConvexQuery(query, skip ? 'skip' : { id });
    return <div>{result?.label ?? 'local loading'}</div>;
  }

  function renderConsumer({
    id = 'project-1',
    skip = false,
  }: { id?: string; skip?: boolean } = {}) {
    root.render(
      <AuthenticatedConvexContext.Provider value={context}>
        <Consumer id={id} skip={skip} />
      </AuthenticatedConvexContext.Provider>
    );
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.queryResult = undefined;
    requestAuthRecovery.mockClear();
    context = {
      authSessionId: 'session-1',
      isAuthenticated: true,
      isLoading: false,
      isRecovering: false,
      confirmedUnauthenticated: false,
      claimAutomaticCommand: () => true,
      requestAuthRecovery,
    };
    mounts = 0;
    unmounts = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('keeps the committed query UI mounted while auth recovers', async () => {
    mocks.queryResult = { label: 'committed data' };
    await act(async () => renderConsumer());
    expect(container.textContent).toBe('committed data');
    expect(mounts).toBe(1);

    mocks.queryResult = unauthenticatedError();
    await act(async () => renderConsumer());

    expect(container.textContent).toBe('committed data');
    expect(requestAuthRecovery).toHaveBeenCalledTimes(1);
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);

    context = { ...context, isAuthenticated: false, isLoading: true, isRecovering: true };
    await act(async () => renderConsumer());
    expect(container.textContent).toBe('committed data');
    expect(unmounts).toBe(0);
  });

  it('uses local loading without throwing when auth fails before the first result', async () => {
    mocks.queryResult = unauthenticatedError();
    await act(async () => renderConsumer());

    expect(container.textContent).toBe('local loading');
    expect(requestAuthRecovery).toHaveBeenCalledTimes(1);
    expect(unmounts).toBe(0);
  });

  it('does not retain cached data across Better Auth sessions', async () => {
    mocks.queryResult = { label: 'first account' };
    await act(async () => renderConsumer());

    context = {
      ...context,
      authSessionId: 'session-2',
      isAuthenticated: false,
      isLoading: true,
      isRecovering: true,
    };
    await act(async () => renderConsumer());

    expect(container.textContent).toBe('local loading');
  });

  it('does not retain cached data for different query arguments', async () => {
    mocks.queryResult = { label: 'first project' };
    await act(async () => renderConsumer());

    context = { ...context, isAuthenticated: false, isLoading: true, isRecovering: true };
    await act(async () => renderConsumer({ id: 'project-2' }));

    expect(container.textContent).toBe('local loading');
  });

  it('retains the committed value across a transient auth skip', async () => {
    mocks.queryResult = { label: 'committed data' };
    await act(async () => renderConsumer());
    expect(container.textContent).toBe('committed data');

    // An offline blip drops Convex auth without the supervisor having flagged
    // recovery yet. The sidebar reads sharing and teammate visibility from this
    // query, so returning `undefined` here makes the private icon and teammate
    // rows flicker until the subscription settles.
    context = { ...context, isAuthenticated: false, isLoading: true };
    await act(async () => renderConsumer());

    expect(container.textContent).toBe('committed data');
    expect(unmounts).toBe(0);
  });

  it('stops retaining data once the user is confirmed logged out', async () => {
    mocks.queryResult = { label: 'committed data' };
    await act(async () => renderConsumer());

    context = {
      ...context,
      isAuthenticated: false,
      isLoading: false,
      confirmedUnauthenticated: true,
    };
    await act(async () => renderConsumer());

    expect(container.textContent).toBe('local loading');
  });

  it('reports loading when auth drops before any snapshot exists', async () => {
    context = { ...context, isAuthenticated: false, isLoading: true };
    await act(async () => renderConsumer());

    expect(container.textContent).toBe('local loading');
  });

  it('does not retain data when the caller skips for a business reason', async () => {
    mocks.queryResult = { label: 'committed data' };
    await act(async () => renderConsumer());

    context = { ...context, isAuthenticated: false, isLoading: true, isRecovering: true };
    await act(async () => renderConsumer({ skip: true }));

    expect(container.textContent).toBe('local loading');
  });

  it('still throws ordinary query failures to the normal error boundary', async () => {
    mocks.queryResult = new Error('ordinary query failure');
    await act(async () => {
      root.render(
        <AuthenticatedConvexContext.Provider value={context}>
          <TestErrorBoundary>
            <Consumer />
          </TestErrorBoundary>
        </AuthenticatedConvexContext.Provider>
      );
    });

    expect(container.textContent).toBe('ordinary fallback');
    expect(requestAuthRecovery).not.toHaveBeenCalled();
  });

  it('does not render raw Convex server details from ordinary boundaries', async () => {
    const BrokenView = () => {
      throw new Error('[CONVEX Q(localProjects:list)] Server Error\n  Called by client');
    };

    await act(async () => {
      root.render(
        <ErrorBoundary showErrorDetails propagateAuthErrors={false}>
          <BrokenView />
        </ErrorBoundary>
      );
    });

    // The crash screen shows the error text it was given, except for raw
    // backend payloads: those stay behind the collapsed details + Copy, so the
    // user is not shown server internals they cannot act on.
    expect(container.textContent).toContain('Lody hit an unexpected error');
    expect(container.textContent).not.toContain('CONVEX');
    expect(container.textContent).not.toContain('Server Error');
  });
});
