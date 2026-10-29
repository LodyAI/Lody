vi.mock('@/lib/desktop-window', () => ({ desktopWindowId: () => '' }));
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
import type {
  PlatformE2eeWorkspaces,
  E2eeRuntimeLedgerView,
  WorkspacesState,
} from '@lody/platform';
import { PersonalHostError } from '@lody/e2ee-client';
const fixture = vi.hoisted(() => ({
  port: undefined as PlatformE2eeWorkspaces | undefined,
  session: { status: 'authenticated', user: { id: 'account', name: 'A', email: 'a@example.test' } },
  clear: () => {},
  workspaceId: 'workspace-native',
  cachedUser: null as { id: string } | null,
  showTools: false,
  workspaces: { status: 'loading' } as WorkspacesState,
  navigation: [] as unknown[],
}));
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useParams: () => ({ workspaceId: fixture.workspaceId }),
  }),
  useNavigate: () => (target: unknown) => {
    fixture.navigation.push(target);
  },
}));
vi.mock('@lody/platform/react', () => ({
  usePlatform: () => ({ e2eeWorkspaces: fixture.port }),
  usePlatformSession: () => fixture.session,
  usePlatformWorkspaces: () => fixture.workspaces,
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
    onOpen,
  }: {
    history: { view: { length: number }; upgradeRequiredAt?: number } | null;
    failure?: unknown;
    memberProfiles?: ReadonlyMap<string, { name: string }>;
    children?: ReactNode;
    onOpen?: () => void;
  }) =>
    createElement(
      Fragment,
      null,
      createElement(
        'p',
        { 'data-control-state': true },
        (failure as { kind?: string } | undefined)?.kind === 'approval-required'
          ? 'approval-required'
          : failure
            ? 'failed'
            : history?.upgradeRequiredAt !== undefined
              ? 'upgrade'
              : (history?.view.length ?? 'loading'),
        ...[...(memberProfiles?.values() ?? [])].map((profile) => ` ${profile.name}`)
      ),
      children,
      onOpen
        ? createElement('button', { 'data-open-workspace': true, onClick: onOpen }, 'open')
        : null
    ),
}));
vi.mock('@/components/settings/e2ee-team-settings', () => ({ E2eeTeamSettingsHost: () => null }));
vi.mock('@/components/e2ee/email-admission-worker', () => ({ EmailAdmissionWorker: () => null }));
vi.mock('@/components/pages/e2ee-personal-pairing', () => ({
  E2eePersonalPairing: ({ workspaceId, approved }: { workspaceId: string; approved?: boolean }) =>
    fixture.showTools
      ? createElement('aside', { 'data-pairing': workspaceId, 'data-approved': Boolean(approved) })
      : null,
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
  fixture.workspaces = { status: 'loading' };
  fixture.navigation = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it.each([false, true])(
  'shows local verified state before network, including damaged renderer markers (%s)',
  async (damaged) => {
    if (damaged) {
      localStorage.setItem(`lody-e2ee-genesis-pin:account:${workspaceId}`, 'broken pin');
      localStorage.setItem(`lody-e2ee-known-mode:account:${workspaceId}`, 'broken marker');
    }
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
        account: async () => ({ userId: 'account', source: 'offline' }),
        recordCreated: async () => {},
        open: async (id) => {
          leases.add(id);
          return local.status;
        },
        close: async (id) => {
          leases.delete(id);
        },
        readIdentity: async () => ({ workspaceId, genesisHash }),
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
  }
);

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
    expect(container.querySelector('[data-control-state]')?.textContent).toBe(
      availability && !mismatch ? '1' : 'failed'
    );
    if (!mismatch && ['custody_unavailable', 'missing-binding', 'corrupt'].includes(code))
      expect(container.textContent).toContain(
        code === 'custody_unavailable' ? 'e2ee.identity.lockedTitle' : 'e2ee.identity.lostTitle'
      );
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

it.each(['identity-lost', 'approval-required'] as const)(
  'a pairing-only host retains public verification and pairing while %s',
  async (code) => {
    fixture.port = displayPort(async () => [] as never);
    delete fixture.port.memberProfiles;
    fixture.showTools = true;
    saveE2eeGenesisPin(localStorage, 'account', workspaceId, genesisHash);
    const body: string[] = [];
    let reads = 0;
    fixture.port.runtime = {
      recordCreated: async () => {
        throw new PersonalHostError({ code: 'unsupported' });
      },
      open: async () => {
        reads++;
        throw new PersonalHostError({ code });
      },
      close: async () => {},
      contentStreamsToken: async () => {
        body.push('token');
        throw new Error('unapproved');
      },
      sealContent: async () => {
        body.push('seal');
        throw new Error('unapproved');
      },
    } as unknown as NonNullable<PlatformE2eeWorkspaces['runtime']>;
    const Component = Route.options.component as () => ReturnType<typeof createElement>;
    await act(async () => root.render(createElement(Component)));
    expect(reads).toBe(1);
    expect(container.textContent).toBe('approval-required');
    expect(container.querySelector('[data-pairing]')?.getAttribute('data-pairing')).toBe(
      workspaceId
    );
    expect(body).toEqual([]);
  }
);

it('closes only its captured portable reader and spares the workspace reader', async () => {
  fixture.port = displayPort(async () => [] as never);
  delete fixture.port.memberProfiles;
  const readers = new Set(['workspace-reader']);
  const closes: unknown[][] = [];
  let controlReader: string | undefined;
  fixture.port.runtime = {
    readerLeases: 'preallocated-v1',
    recordCreated: async () => {},
    open: async (_id, _checkpoint, expected, requested) => {
      expect(expected).toBe('account');
      controlReader = requested;
      readers.add(requested ?? 'legacy-control-reader');
      return { ...local.status, readerOwner: requested };
    },
    ledgerView: async () => local,
    ingestLedgerRecords: async () => local.status,
    close: async (...args) => {
      closes.push(args);
      if (args[2]) readers.delete(args[2]);
      else readers.clear();
    },
  } as NonNullable<PlatformE2eeWorkspaces['runtime']>;
  const Component = Route.options.component as () => ReturnType<typeof createElement>;
  await act(async () => root.render(createElement(Component)));
  expect(controlReader).toBeTypeOf('string');
  await act(async () => root.unmount());
  expect(new Set(closes.map((entry) => JSON.stringify(entry)))).toEqual(
    new Set([JSON.stringify([workspaceId, 'account', controlReader])])
  );
  expect([...readers]).toEqual(['workspace-reader']);
});

it('fences the preallocated control reader before a cold open settles', async () => {
  fixture.port = displayPort(async () => [] as never);
  delete fixture.port.memberProfiles;
  const opened = Promise.withResolvers<typeof local.status>();
  const entered = Promise.withResolvers<void>();
  const closes: unknown[][] = [];
  let pendingReader: string | undefined;
  fixture.port.runtime = {
    readerLeases: 'preallocated-v1',
    open: async (_id, _checkpoint, _account, requested) => {
      pendingReader = requested;
      entered.resolve();
      return opened.promise;
    },
    close: async (...args) => {
      closes.push(args);
    },
  } as unknown as NonNullable<PlatformE2eeWorkspaces['runtime']>;
  const Component = Route.options.component as () => ReturnType<typeof createElement>;
  try {
    await act(async () => root.render(createElement(Component)));
    await entered.promise;
    await act(async () => root.unmount());
    expect(pendingReader).toBeTypeOf('string');
    expect(closes).toEqual([[workspaceId, 'account', pendingReader]]);
  } finally {
    await act(async () => opened.resolve({ ...local.status, readerOwner: pendingReader }));
  }
  expect(container.textContent).toBe('');
  expect(closes.at(-1)).toEqual([workspaceId, 'account', pendingReader]);
});

it.each(['describe', 'history'] as const)(
  'reopens a confirmed closed reader before obsolete public %s returns',
  async (paused) => {
    fixture.port = displayPort(async () => [] as never);
    delete fixture.port.memberProfiles;
    const descriptor = await fixture.port.describe({ workspaceId });
    const page = await fixture.port.history({ workspaceId });
    const described = Promise.withResolvers<typeof descriptor>();
    const historical = Promise.withResolvers<typeof page>();
    const entered = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const readers = new Set<string>();
    const ingested: unknown[] = [];
    let descriptions = 0,
      histories = 0;
    fixture.port.describe = async () => {
      if (++descriptions === 1 && paused === 'describe') {
        entered.resolve();
        return described.promise;
      }
      return descriptor;
    };
    fixture.port.history = async () => {
      if (++histories === 1 && paused === 'history') {
        entered.resolve();
        return historical.promise;
      }
      return page;
    };
    fixture.port.runtime = {
      readerLeases: 'preallocated-v1',
      recordCreated: async () => {},
      open: async (_id, _checkpoint, expected, requested) => {
        expect(expected).toBe('account');
        readers.add(requested!);
        return { ...local.status, readerOwner: requested };
      },
      close: async (_id, expected, reader) => {
        expect(expected).toBe('account');
        readers.delete(reader!);
        closed.resolve();
      },
      ledgerView: async () => local,
      ingestLedgerRecords: async (_id, received) => {
        ingested.push(received);
        return local.status;
      },
    } as NonNullable<PlatformE2eeWorkspaces['runtime']>;
    const Component = Route.options.component as () => ReturnType<typeof createElement>;
    try {
      await act(async () => root.render(createElement(Component)));
      await entered.promise;
      expect(container.querySelector('[data-control-state]')?.textContent).toBe('1');
      await act(async () => root.unmount());
      await closed.promise;
      expect(readers.size).toBe(0);
      root = createRoot(container);
      await act(async () => root.render(createElement(Component)));
      expect(container.querySelector('[data-control-state]')?.textContent).toBe('1');
      expect(readers.size).toBe(1);
      const current = [...readers];
      const received = [...ingested];
      // Late, conflicting public results belong only to the disposed lifetime.
      await act(async () => {
        described.resolve({ ...descriptor, genesisHash: 'ff'.repeat(32) } as typeof descriptor);
        historical.resolve({ ...page, recordsHex: ['00'] });
      });
      expect(container.querySelector('[data-control-state]')?.textContent).toBe('1');
      expect([...readers]).toEqual(current);
      expect(ingested).toEqual(received);
    } finally {
      await act(async () => {
        described.resolve(descriptor);
        historical.resolve(page);
      });
    }
  }
);

it('does not let an old public-directory read block a newly available protected host', async () => {
  const described =
    Promise.withResolvers<Awaited<ReturnType<PlatformE2eeWorkspaces['describe']>>>();
  const entered = Promise.withResolvers<void>();
  fixture.port = displayPort(async () => [] as never);
  const descriptor = await fixture.port.describe({ workspaceId });
  fixture.port.describe = async () => {
    entered.resolve();
    return described.promise;
  };
  const Component = Route.options.component as () => ReturnType<typeof createElement>;
  try {
    await act(async () => root.render(createElement(Component)));
    await entered.promise;
    await act(async () => root.unmount());
    fixture.port = displayPort(async () => [] as never);
    fixture.port.runtime = {
      open: async () => local.status,
      recordCreated: async () => {},
      close: async () => {},
      ledgerView: async () => local,
      ingestLedgerRecords: async () => local.status,
    };
    root = createRoot(container);
    await act(async () => root.render(createElement(Component)));
    expect(container.querySelector('[data-control-state]')?.textContent).toBe('1');
  } finally {
    await act(async () => described.resolve(descriptor));
  }
});

it('retains an incomplete cold reader across remounts while independent workspaces remain usable', async () => {
  const opened = Promise.withResolvers<typeof local.status>();
  const entered = Promise.withResolvers<void>();
  const incomplete = Object.assign(new Error('close incomplete'), { owner: {} });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const attempts: string[] = [];
  let blocked = true;
  let firstReader: string | undefined;
  fixture.port = displayPort(async () => [] as never);
  delete fixture.port.memberProfiles;
  fixture.port.runtime = {
    readerLeases: 'preallocated-v1',
    recordCreated: async () => {},
    open: async (id, _checkpoint, _account, reader) => {
      attempts.push(id);
      if (attempts.length === 1) {
        firstReader = reader;
        entered.resolve();
        return opened.promise;
      }
      return { ...local.status, workspaceId: id, readerOwner: reader };
    },
    ledgerView: async (id) => ({ ...local, status: { ...local.status, workspaceId: id } }),
    ingestLedgerRecords: async (id) => ({ ...local.status, workspaceId: id }),
    close: async (id, account, reader) => {
      expect(account).toBe('account');
      if (id === workspaceId && reader === firstReader && blocked) throw incomplete;
    },
  } as NonNullable<PlatformE2eeWorkspaces['runtime']>;
  const Component = Route.options.component as () => ReturnType<typeof createElement>;
  try {
    await act(async () => root.render(createElement(Component)));
    await entered.promise;
    await act(async () => root.unmount());
    // The replacement knows a genesis that the cancelled cold open has not returned.
    saveE2eeGenesisPin(localStorage, 'account', workspaceId, genesisHash);
    root = createRoot(container);
    await act(async () => root.render(createElement(Component)));
    expect(container.textContent).toBe('failed');
    expect(attempts).toEqual([workspaceId]);
    fixture.workspaceId = 'independent-workspace';
    await act(async () => root.render(createElement(Component)));
    expect(attempts).toEqual([workspaceId, 'independent-workspace']);
    expect(container.querySelector('[data-control-state]')?.textContent).toBe('1');
    blocked = false;
    await act(async () => opened.resolve({ ...local.status, readerOwner: firstReader }));
    fixture.workspaceId = workspaceId;
    await act(async () => root.render(createElement(Component)));
    expect(attempts).toEqual([workspaceId, 'independent-workspace', workspaceId]);
    expect(container.textContent).toBe('1');
    expect(errors.mock.calls).not.toEqual([]);
    expect(errors.mock.calls.every((entry) => entry.length === 1)).toBe(true);
  } finally {
    blocked = false;
    await act(async () => opened.resolve({ ...local.status, readerOwner: firstReader }));
    errors.mockRestore();
  }
});

it('offers the routed workspace only after a successful approved host open', async () => {
  fixture.showTools = true;
  fixture.workspaces = {
    status: 'ready',
    activeWorkspaceId: workspaceId,
    workspaces: [{ id: workspaceId, slug: 'protected-home', name: 'Protected', role: 'member' }],
  };
  fixture.port = displayPort(async () => [] as never);
  delete fixture.port.memberProfiles;
  let approved = false;
  fixture.port.runtime = {
    open: async () => {
      if (!approved) throw new PersonalHostError({ code: 'approval-required' });
      return local.status;
    },
    ledgerView: async () => local,
    ingestLedgerRecords: async () => local.status,
    recordCreated: async () => {
      throw new PersonalHostError({ code: 'unsupported' });
    },
    close: async () => {},
  } as unknown as NonNullable<PlatformE2eeWorkspaces['runtime']>;
  const Component = Route.options.component as () => ReturnType<typeof createElement>;
  await act(async () => root.render(createElement(Component)));
  expect(container.querySelector('[data-open-workspace]')).toBeNull();
  expect(container.querySelector('[data-pairing]')).not.toBeNull();
  approved = true;
  await act(async () => window.dispatchEvent(new Event('online')));
  const open = container.querySelector<HTMLButtonElement>('[data-open-workspace]');
  expect(open).not.toBeNull();
  expect(container.querySelector('[data-pairing]')?.getAttribute('data-approved')).toBe('true');
  await act(async () => open!.click());
  expect(fixture.navigation).toEqual([
    { to: '/$workspaceName/chat', params: { workspaceName: 'protected-home' } },
  ]);
});

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
