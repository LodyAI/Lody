/** @vitest-environment jsdom */

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
import {
  useRecoverableConvexQuery,
  useOptionalRecoverableConvexQuery,
} from '../src/hooks/use-recoverable-convex-query';
import { ErrorBoundary } from '../src/components/error-boundary';

const mocks = vi.hoisted(() => ({
  queryResult: undefined as unknown,
  resultsById: new Map<string, unknown>(),
  listeners: new Set<() => void>(),
  activeWatches: 0,
  subscriptions: 0,
  client: {} as unknown,
}));

vi.mock('convex/react', () => ({
  useConvex: () => mocks.client,
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
  let renderLabels: string[];
  const requestAuthRecovery = vi.fn();

  function Consumer({ id = 'project-1', skip = false }: { id?: string; skip?: boolean }) {
    useEffect(() => {
      mounts += 1;
      return () => {
        unmounts += 1;
      };
    }, []);
    const result = useRecoverableConvexQuery(query, skip ? 'skip' : { id });
    renderLabels.push(result?.label ?? 'local loading');
    return <div>{result?.label ?? 'local loading'}</div>;
  }

  function renderConsumer({
    id = 'project-1',
    skip = false,
  }: { id?: string; skip?: boolean } = {}) {
    for (const listener of mocks.listeners) listener();
    root.render(
      <AuthenticatedConvexContext.Provider value={context}>
        <Consumer id={id} skip={skip} />
      </AuthenticatedConvexContext.Provider>
    );
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.queryResult = undefined;
    mocks.resultsById.clear();
    mocks.listeners.clear();
    mocks.activeWatches = 0;
    mocks.subscriptions = 0;
    mocks.client = {
      watchQuery: (_query: unknown, args: { id?: string }) => ({
        localQueryResult: () => {
          const result =
            args.id && mocks.resultsById.has(args.id)
              ? mocks.resultsById.get(args.id)
              : mocks.queryResult;
          if (result instanceof Error) throw result;
          return result;
        },
        onUpdate: (listener: () => void) => {
          mocks.activeWatches += 1;
          mocks.subscriptions += 1;
          mocks.listeners.add(listener);
          return () => {
            mocks.activeWatches -= 1;
            mocks.listeners.delete(listener);
          };
        },
      }),
    };
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
    renderLabels = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
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

  it('does not retain data when the caller skips for a business reason', async () => {
    mocks.queryResult = { label: 'committed data' };
    await act(async () => renderConsumer());

    context = { ...context, isAuthenticated: false, isLoading: true, isRecovering: true };
    await act(async () => renderConsumer({ skip: true }));

    expect(container.textContent).toBe('local loading');
  });

  it('returns optional catalog failure as scoped data while its ordinary sibling stays mounted', async () => {
    mocks.queryResult = new Error('ordinary query failure');
    function Optional() {
      const result = useOptionalRecoverableConvexQuery(query, { id: 'project-1' });
      return <div>{result.error ? 'optional failed' : 'optional loading'}</div>;
    }
    await act(async () =>
      root.render(
        <AuthenticatedConvexContext.Provider value={context}>
          <span>ordinary work</span>
          <Optional />
        </AuthenticatedConvexContext.Provider>
      )
    );
    expect(container.textContent).toContain('ordinary work');
    expect(container.textContent).toContain('optional failed');
  });

  it('lets a user retry one failed directory shared by mounted consumers without polling or disrupting sibling work', async () => {
    vi.useFakeTimers();
    mocks.queryResult = new Error('directory failed');
    const memberQuery = makeFunctionReference<
      'query',
      { workspaceId: string; accountId: string },
      Array<{ userId: string; name: string; image: null }>
    >('workspaceMembers:list');
    function Directory() {
      const result = useOptionalRecoverableConvexQuery(memberQuery, {
        workspaceId: 'workspace-1',
        accountId: 'account-1',
      });
      return (
        <div>
          {result.data?.map((member) => member.name).join(',') ??
            (result.error ? 'directory failed' : 'loading')}
          <button onClick={result.retry}>Retry directory</button>
        </div>
      );
    }
    await act(async () =>
      root.render(
        <AuthenticatedConvexContext.Provider value={context}>
          <span>sharing controls</span>
          <Directory />
          <Directory />
        </AuthenticatedConvexContext.Provider>
      )
    );
    expect(container.textContent?.match(/directory failed/g)?.length).toBe(2);
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain('sharing controls');
    await act(async () => vi.advanceTimersByTime(1000));
    await deliver([{ userId: 'joined', name: 'joined member', image: null }]);
    expect(container.textContent?.match(/joined member/g)?.length).toBe(2);
    const settledSubscriptions = mocks.subscriptions;
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(mocks.subscriptions).toBe(settledSubscriptions);
    expect(container.textContent?.match(/joined member/g)?.length).toBe(2);
  });

  function serverError(requestId = 'synthetic-1'): Error {
    return new Error(
      `[CONVEX Q(test:get)] [Request ID: ${requestId}] Server Error\n  Called by client`
    );
  }

  async function deliver(value: unknown) {
    await act(async () => {
      mocks.queryResult = value;
      for (const listener of [...mocks.listeners]) listener();
    });
  }

  async function advance(ms: number) {
    await act(async () => vi.advanceTimersByTime(ms));
  }

  function renderWithBoundary(children: ReactNode = <Consumer />) {
    root.render(
      <AuthenticatedConvexContext.Provider value={context}>
        <TestErrorBoundary>{children}</TestErrorBoundary>
      </AuthenticatedConvexContext.Provider>
    );
  }

  it('retries an opaque server failure without unmounting the application', async () => {
    vi.useFakeTimers();
    await act(async () => renderWithBoundary());
    await deliver({ label: 'initial data' });
    await deliver(serverError());

    expect(container.textContent).toBe('local loading');
    expect(unmounts).toBe(0);
    expect(mocks.activeWatches).toBe(0);
    await advance(999);
    expect(mocks.activeWatches).toBe(0);
    await advance(1);
    expect(mocks.activeWatches).toBe(1);
    // The stale SDK error is still present. It must not consume another retry
    // until the new subscription receives a server response.
    expect(container.textContent).toBe('local loading');
    await advance(10_000);
    expect(mocks.subscriptions).toBe(2);

    await deliver({ label: 'recovered data' });
    expect(container.textContent).toBe('recovered data');
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(requestAuthRecovery).not.toHaveBeenCalled();
  });

  it('retires a previous query scope and ignores its late callbacks', async () => {
    vi.useFakeTimers();
    mocks.resultsById.set('project-1', { label: 'first project' });
    mocks.resultsById.set('project-2', { label: 'second project' });
    await act(async () => renderConsumer());
    const retiredCallback = [...mocks.listeners][0]!;
    await deliver(serverError());
    // Deliver the failure specifically to the old query, then replace its scope.
    mocks.resultsById.set('project-1', serverError());
    await act(async () => {
      for (const listener of [...mocks.listeners]) listener();
      renderConsumer({ id: 'project-2' });
    });
    expect(container.textContent).toBe('second project');
    await act(async () => retiredCallback());
    await advance(60_000);
    expect(container.textContent).toBe('second project');
    expect(mocks.activeWatches).toBe(1);
  });

  it('hands a persistent failure to the boundary after three retries, despite changing IDs', async () => {
    vi.useFakeTimers();
    await act(async () => renderWithBoundary());
    await deliver(serverError('synthetic-0'));
    for (const [index, delay] of [1_000, 2_000, 4_000].entries()) {
      expect(container.textContent).toBe('local loading');
      await advance(delay);
      await deliver(serverError(`synthetic-${index + 1}`));
    }
    expect(container.textContent).toBe('ordinary fallback');
    expect(mocks.activeWatches).toBe(0);
    await advance(60_000);
    expect(container.textContent).toBe('ordinary fallback');
    expect(mocks.subscriptions).toBe(4);
  });

  it('does not retry structured application errors even if their message looks transient', async () => {
    vi.useFakeTimers();
    const error = new ConvexError('Permission denied');
    error.message = serverError().message;
    mocks.queryResult = error;
    await act(async () => renderWithBoundary());
    expect(container.textContent).toBe('ordinary fallback');
    await advance(60_000);
    expect(mocks.subscriptions).toBe(1);
  });

  it('does not reset the retry budget on a brief successful result or auth skip', async () => {
    vi.useFakeTimers();
    await act(async () => renderWithBoundary());
    await deliver(serverError());
    await advance(1_000);
    await deliver({ label: 'brief success' });
    context = { ...context, isAuthenticated: false, isLoading: true };
    await act(async () => renderWithBoundary());
    expect(container.textContent).toBe('brief success');
    context = { ...context, isAuthenticated: true, isLoading: false };
    await act(async () => renderWithBoundary());
    await deliver(serverError('synthetic-2'));
    await advance(1_000);
    expect(mocks.activeWatches).toBe(0);
    await advance(1_000);
    await deliver(serverError('synthetic-3'));
    await advance(4_000);
    await deliver(serverError('synthetic-4'));
    expect(container.textContent).toBe('ordinary fallback');
  });

  it('does not resurrect stale authorization data when auth drops during server recovery', async () => {
    vi.useFakeTimers();
    mocks.queryResult = { label: 'previous access' };
    await act(async () => renderConsumer());
    await deliver(serverError());
    expect(container.textContent).toBe('local loading');
    context = { ...context, isAuthenticated: false, isLoading: true };
    await act(async () => renderConsumer());
    expect(container.textContent).toBe('local loading');
    expect(unmounts).toBe(0);
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
    expect(container.textContent).toContain("This part couldn't be shown");
    expect(container.textContent).not.toContain('CONVEX');
    expect(container.textContent).not.toContain('Server Error');
  });
});
