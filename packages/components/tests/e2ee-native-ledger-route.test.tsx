// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Result } from 'effect';
import {
  Bytes,
  exportVerifiedState,
  hashRecordBytes,
  verifyLedger,
} from '@lody/e2ee-core/protocol';
import type { PlatformE2eeWorkspaces, E2eeRuntimeLedgerView } from '@lody/platform';
const fixture = vi.hoisted(() => ({
  port: undefined as PlatformE2eeWorkspaces | undefined,
  session: { status: 'authenticated', user: { id: 'account', name: 'A', email: 'a@example.test' } },
  clear: () => {},
  workspaceId: 'workspace-native',
  cachedUser: null as { id: string } | null,
  showTools: false,
}));
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useParams: () => ({ workspaceId: fixture.workspaceId }),
  }),
  useNavigate: () => () => {},
}));
vi.mock('@lody/platform/react', () => ({
  usePlatform: () => ({ e2eeWorkspaces: fixture.port }),
  usePlatformSession: () => fixture.session,
}));
vi.mock('jotai', () => ({
  useSetAtom: () => fixture.clear,
  useAtomValue: () => fixture.cachedUser,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/atoms', () => ({ setWorkspaceContextAtom: 'workspace', userAtom: 'user' }));
vi.mock('@/atoms/runtime', () => ({ activeWorkspaceRuntimeAtom: 'runtime' }));
vi.mock('@/components/pages/e2ee-workspace-control-page', () => ({
  E2eeWorkspaceControlPage: ({
    history,
    failure,
    memberProfiles,
    children,
  }: {
    history: { view: { length: number }; upgradeRequiredAt?: number } | null;
    failure?: unknown;
    memberProfiles?: ReadonlyMap<string, { name: string }>;
    children?: ReactNode;
  }) =>
    createElement(
      Fragment,
      null,
      createElement(
        'p',
        null,
        failure
          ? 'failed'
          : history?.upgradeRequiredAt !== undefined
            ? 'upgrade'
            : (history?.view.length ?? 'loading'),
        ...[...(memberProfiles?.values() ?? [])].map((profile) => ` ${profile.name}`)
      ),
      children
    ),
}));
vi.mock('@/components/pages/e2ee-personal-pairing', () => ({
  E2eePersonalPairing: ({ workspaceId }: { workspaceId: string }) =>
    fixture.showTools ? createElement('aside', { 'data-pairing': workspaceId }) : null,
}));
vi.mock('@/components/pages/e2ee-ledger-audit', () => ({
  E2eeLedgerAudit: ({ workspaceId }: { workspaceId: string }) =>
    fixture.showTools ? createElement('aside', { 'data-audit': workspaceId }) : null,
}));
import { saveE2eeGenesisPin } from '../src/lib/e2ee-workspace-storage';
import { Route } from '../src/routes/workspace/e2ee/$workspaceId';
import { useE2eeAccountId } from '../src/lib/e2ee-account';
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const workspaceId = 'workspace-native';
const raw =
  '82860158208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c58200202020202020202020202020202020202020202020202020202020202020202500303030303030303030303030303030358200404040404040404040404040404040404040404040404040404040404040404582005050505050505050505050505050505050505050505050505050505050505055840116dc6d18360ac4d1020a255f4c4589f2bd533b045db20794f431079f298523ab37223a4d861f55ca506abb41876e2aefada1ee6931e9ca7e89c6a6235901a03';
const bytes = new Uint8Array(raw.match(/../g)!.map((value) => Number.parseInt(value, 16)));
const hash = hashRecordBytes(bytes);
const genesisHash = Array.from(hash.toBytes(), (value) => value.toString(16).padStart(2, '0')).join(
  ''
);
const state = Result.getOrThrow(
  exportVerifiedState(
    Result.getOrThrow(
      verifyLedger({
        anchor: Result.getOrThrow(Bytes.genesisHash(hash.toBytes())),
        records: [bytes],
        checkpoint: { head: hash, length: 1 },
      })
    )
  )
);
const hex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
const local: E2eeRuntimeLedgerView = {
  stateHex: hex(state.bytes),
  recordsHex: [raw],
  status: {
    workspaceId,
    genesisHash,
    length: 1,
    headHash: genesisHash,
    stateDigest: hex(state.stateDigest.toBytes()),
    position: `p1:${workspaceId}:1:source:0`,
    epoch: 0,
    rotationRequired: false,
    deviceKind: 'personal',
    hasCurrentKey: true,
    continuityPending: false,
  },
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  localStorage.clear();
  fixture.session.status = 'authenticated';
  fixture.session.user.id = 'account';
  fixture.workspaceId = workspaceId;
  fixture.cachedUser = null;
  fixture.showTools = false;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it('shows local verified state before network and resumes history from its saved position', async () => {
  const description =
    Promise.withResolvers<Awaited<ReturnType<PlatformE2eeWorkspaces['describe']>>>();
  const entered = Promise.withResolvers<void>();
  const reads: unknown[] = [];
  const leases = new Set<string>();
  fixture.port = {
    create: async () => {
      throw new Error('unused');
    },
    describe: async () => {
      entered.resolve();
      return description.promise;
    },
    history: async (request) => {
      reads.push(request);
      return {
        workspaceId,
        genesisHash,
        checkpoint: { headHash: genesisHash, length: 1 },
        startIndex: 1,
        recordsHex: [],
        position: local.status.position!,
        nextCursor: null,
      };
    },
    runtime: {
      recordCreated: async () => {},
      open: async (id) => {
        leases.add(id);
        return local.status;
      },
      close: async (id) => {
        leases.delete(id);
      },
      status: async () => local.status,
      ledgerView: async () => local,
      ingestLedgerRecords: async () => local.status,
    },
  };
  const Component = Route.options.component as () => ReturnType<typeof createElement>;
  await act(async () => {
    root.render(createElement(Component));
  });
  await entered.promise;
  expect(container.textContent).toBe('1');
  expect(reads).toEqual([]);
  await act(async () => {
    description.resolve({
      workspaceId,
      contentMode: 'e2ee',
      contentModeVersion: 1,
      genesisHash,
      cryptoOrgId: genesisHash,
      activation: 'control-only',
    });
  });
  expect(reads).toEqual([{ workspaceId, after: local.status.position }]);
  await act(async () => root.unmount());
  expect(leases.size).toBe(0);
});

for (const upgrade of [false, true]) {
  it(`publishes only the completed view or a mid-page upgrade (${upgrade})`, async () => {
    const continueSync = Promise.withResolvers<void>();
    let phase = 0;
    const publishedPhases: number[] = [];
    const pagesRead: (string | undefined)[] = [];
    fixture.port = {
      create: async () => {
        throw new Error('unused');
      },
      describe: async () => ({
        workspaceId,
        contentMode: 'e2ee',
        contentModeVersion: 1,
        genesisHash,
        cryptoOrgId: genesisHash,
        activation: 'control-only',
      }),
      history: async (request) => {
        pagesRead.push(request.cursor);
        if (request.cursor === 'page-2') await continueSync.promise;
        return {
          workspaceId,
          genesisHash,
          checkpoint: { headHash: genesisHash, length: 1 },
          startIndex: 1,
          recordsHex: [],
          position: local.status.position!,
          nextCursor:
            request.cursor === 'page-3' ? null : request.cursor === 'page-2' ? 'page-3' : 'page-2',
        };
      },
      runtime: {
        recordCreated: async () => {},
        open: async () => local.status,
        close: async () => {},
        status: async () => local.status,
        ingestLedgerRecords: async () => {
          phase++;
          return { ...local.status, ...(upgrade && phase === 2 ? { upgradeRequiredAt: 1 } : {}) };
        },
        ledgerView: async () => {
          if (phase === 1 || (!upgrade && phase === 2))
            throw new Error('incomplete view must not cross IPC');
          publishedPhases.push(phase);
          return {
            ...local,
            status: {
              ...local.status,
              ...(upgrade && phase === 2 ? { upgradeRequiredAt: 1 } : {}),
            },
          };
        },
      },
    };
    const Component = Route.options.component as () => ReturnType<typeof createElement>;
    await act(async () => root.render(createElement(Component)));
    expect(container.textContent).toBe('1');
    expect(pagesRead).toEqual([undefined, 'page-2']);
    await act(async () => {
      continueSync.resolve();
    });
    expect(container.textContent).toBe(upgrade ? 'upgrade' : '1');
    expect(publishedPhases).toEqual(upgrade ? [0, 2] : [0, 3]);
    expect(pagesRead).toEqual(upgrade ? [undefined, 'page-2'] : [undefined, 'page-2', 'page-3']);
  });
}

it.each([
  ['custody_unavailable', false, 'open', false],
  ['custody_unavailable', true, 'open', false],
  ['custody_unavailable', true, 'recordCreated', false],
  ['account_unavailable', true, 'open', false],
  ['missing-binding', true, 'open', false],
  ['closed', true, 'open', false],
  ['custody_unavailable', true, 'open', true],
  ['local-evidence-conflict', true, 'open', false],
  ['conflict', true, 'recordCreated', false],
  ['corrupt', true, 'open', false],
] as const)(
  'keeps read-only verification for %s (pin=%s, at=%s, mismatched pin=%s)',
  async (code, pinned, at, mismatch) => {
    if (pinned)
      saveE2eeGenesisPin(
        localStorage,
        'account',
        workspaceId,
        mismatch ? 'a'.repeat(64) : genesisHash
      );
    const fetched: string[] = [];
    fixture.port = {
      create: async () => {
        throw new Error('unused');
      },
      describe: async () => {
        fetched.push('describe');
        return {
          workspaceId,
          contentMode: 'e2ee',
          contentModeVersion: 1,
          genesisHash,
          cryptoOrgId: genesisHash,
          activation: 'control-only',
        };
      },
      history: async () => ({
        workspaceId,
        genesisHash,
        checkpoint: { headHash: genesisHash, length: 1 },
        startIndex: 0,
        recordsHex: [raw],
        position: local.status.position!,
        nextCursor: null,
      }),
      runtime: {
        recordCreated: async () => {
          if (at === 'recordCreated') throw new Error(`e2ee_${code}`);
        },
        open: async () => {
          throw new Error(`Error invoking remote method 'e2ee:open': Error: e2ee_${code}`);
        },
        close: async () => {},
        status: async () => local.status,
        ledgerView: async () => {
          throw new Error('native view must not be used');
        },
        ingestLedgerRecords: async () => {
          throw new Error('native ingestion must not be used');
        },
      },
    };
    const Component = Route.options.component as () => ReturnType<typeof createElement>;
    await act(async () => root.render(createElement(Component)));
    const availability = [
      'custody_unavailable',
      'account_unavailable',
      'missing-binding',
      'closed',
    ].includes(code);
    expect(container.textContent).toBe(availability && !mismatch ? '1' : 'failed');
    expect(fetched).toEqual(availability ? ['describe'] : []);
  }
);

it('opens the local ledger with an expired renderer snapshot and offline main identity, then reconnects', async () => {
  fixture.session.status = 'loading';
  localStorage.setItem('lody_auth_token', 'synthetic-offline-bearer');
  localStorage.setItem(
    'lody:auth-bootstrap',
    JSON.stringify({
      user: { id: 'account', name: 'A', email: 'a@example.test' },
      updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    })
  );
  let online = false;
  let matchedBearer = false;
  fixture.port = {
    create: async () => {
      throw new Error('unused');
    },
    describe: async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return {
        workspaceId,
        contentMode: 'e2ee',
        contentModeVersion: 1,
        genesisHash,
        cryptoOrgId: genesisHash,
        activation: 'control-only',
      };
    },
    history: async () => ({
      workspaceId,
      genesisHash,
      checkpoint: { headHash: genesisHash, length: 1 },
      startIndex: 1,
      recordsHex: [],
      position: local.status.position!,
      nextCursor: null,
    }),
    runtime: {
      account: async (input) => {
        matchedBearer = input?.token === 'synthetic-offline-bearer';
        return matchedBearer ? { userId: 'account', source: 'offline' } : null;
      },
      recordCreated: async () => {},
      open: async () => local.status,
      close: async () => {},
      status: async () => local.status,
      ingestLedgerRecords: async () => local.status,
      ledgerView: async () => local,
    },
  };
  const Component = Route.options.component as () => ReturnType<typeof createElement>;
  await act(async () => root.render(createElement(Component)));
  expect(matchedBearer).toBe(true);
  expect(container.textContent).toBe('sessions.offline1');
  online = true;
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(container.textContent).toBe('1');
});

it('keeps E2EE identity IPC dormant for an ordinary workspace even while auth is loading', async () => {
  fixture.session.status = 'loading';
  fixture.port = {
    create: async () => {
      throw new Error('unused');
    },
    describe: async () => {
      throw new Error('unused');
    },
    history: async () => {
      throw new Error('unused');
    },
    runtime: {
      account: () => {
        throw new Error('ordinary workspace must not call E2EE account IPC');
      },
      recordCreated: async () => {},
      open: async () => local.status,
      close: async () => {},
      status: async () => local.status,
      ingestLedgerRecords: async () => local.status,
      ledgerView: async () => local,
    },
  };
  function OrdinaryWorkspace() {
    const id = useE2eeAccountId(false);
    return createElement('p', null, id ?? 'ordinary');
  }
  await act(async () => root.render(createElement(OrdinaryWorkspace)));
  expect(container.textContent).toBe('ordinary');
});

function displayPort(
  memberProfiles: NonNullable<PlatformE2eeWorkspaces['memberProfiles']>
): PlatformE2eeWorkspaces {
  return {
    create: async () => {
      throw new Error('unused');
    },
    describe: async ({ workspaceId: id }) => ({
      workspaceId: id,
      contentMode: 'e2ee',
      contentModeVersion: 1,
      genesisHash,
      cryptoOrgId: genesisHash,
      activation: 'control-only',
    }),
    history: async ({ workspaceId: id }) => ({
      workspaceId: id,
      genesisHash,
      checkpoint: { headHash: genesisHash, length: 1 },
      startIndex: 0,
      recordsHex: [raw],
      position: 'position',
      nextCursor: null,
    }),
    memberProfiles,
  };
}

it('shows verified history during a slow or failed directory and recovers labels on refresh', async () => {
  const pending =
    Promise.withResolvers<
      Awaited<ReturnType<NonNullable<PlatformE2eeWorkspaces['memberProfiles']>>>
    >();
  let count = 0;
  fixture.port = displayPort(() =>
    ++count === 1
      ? pending.promise
      : Promise.resolve({
          workspaceId,
          profiles: [{ cryptoUserId: '02'.repeat(32), name: 'Recovered label', image: null }],
        })
  );
  const Component = Route.options.component as () => ReturnType<typeof createElement>;
  await act(async () => root.render(createElement(Component)));
  expect(container.textContent).toBe('1');
  await act(async () => pending.reject(new Error('directory unavailable')));
  expect(container.textContent).toBe('1');
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(container.textContent).toBe('1 Recovered label');
});

it.each(['account', 'workspace'] as const)(
  'ignores a late display directory after %s changes',
  async (change) => {
    const pending =
      Promise.withResolvers<
        Awaited<ReturnType<NonNullable<PlatformE2eeWorkspaces['memberProfiles']>>>
      >();
    let count = 0;
    fixture.port = displayPort(async ({ workspaceId: id }) =>
      ++count === 1
        ? pending.promise
        : {
            workspaceId: id,
            profiles: [{ cryptoUserId: '02'.repeat(32), name: 'Current label', image: null }],
          }
    );
    const Component = Route.options.component as () => ReturnType<typeof createElement>;
    await act(async () => root.render(createElement(Component)));
    if (change === 'account') fixture.session.user.id = 'next-account';
    else fixture.workspaceId = 'next-workspace';
    await act(async () => root.render(createElement(Component)));
    expect(container.textContent).toBe('1 Current label');
    await act(async () =>
      pending.resolve({
        workspaceId,
        profiles: [{ cryptoUserId: '02'.repeat(32), name: 'Stale label', image: null }],
      })
    );
    expect(container.textContent).toBe('1 Current label');
  }
);

it('retains pairing and audit beside verified history when the independent directory fails', async () => {
  fixture.showTools = true;
  const pending =
    Promise.withResolvers<
      Awaited<ReturnType<NonNullable<PlatformE2eeWorkspaces['memberProfiles']>>>
    >();
  saveE2eeGenesisPin(localStorage, 'account', workspaceId, genesisHash);
  fixture.port = {
    ...displayPort(() => pending.promise),
    runtime: {
      recordCreated: async () => {},
      open: async () => local.status,
      close: async () => {},
      status: async () => local.status,
      ledgerView: async () => local,
      ingestLedgerRecords: async () => local.status,
    },
  };
  const Component = Route.options.component as () => ReturnType<typeof createElement>;
  await act(async () => root.render(createElement(Component)));
  expect(container.textContent).toBe('1');
  expect(container.querySelector('[data-pairing]')?.getAttribute('data-pairing')).toBe(workspaceId);
  expect(container.querySelector('[data-audit]')?.getAttribute('data-audit')).toBe(workspaceId);
  await act(async () => pending.reject(new Error('synthetic directory outage')));
  expect(container.textContent).toBe('1');
  expect(container.querySelector('[data-pairing]')).not.toBeNull();
  expect(container.querySelector('[data-audit]')).not.toBeNull();
});
