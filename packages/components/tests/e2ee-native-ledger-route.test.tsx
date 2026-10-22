// @vitest-environment jsdom
import { act, createElement } from 'react';
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
}));
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useParams: () => ({ workspaceId: 'workspace-native' }),
  }),
  useNavigate: () => () => {},
}));
vi.mock('@lody/platform/react', () => ({
  usePlatform: () => ({ e2eeWorkspaces: fixture.port }),
  usePlatformSession: () => fixture.session,
}));
vi.mock('jotai', () => ({ useSetAtom: () => fixture.clear }));
vi.mock('@/atoms', () => ({ setWorkspaceContextAtom: 'workspace' }));
vi.mock('@/components/pages/e2ee-workspace-control-page', () => ({
  E2eeWorkspaceControlPage: ({ history, failure }: { history: { view: { length: number }; upgradeRequiredAt?: number } | null; failure?: unknown }) =>
    createElement('p', null, failure ? 'failed' : history?.upgradeRequiredAt !== undefined ? 'upgrade' : history?.view.length ?? 'loading'),
}));
import { saveE2eeGenesisPin } from '../src/lib/e2ee-workspace-storage';
import { Route } from '../src/routes/workspace/e2ee/$workspaceId';
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
      create: async () => { throw new Error('unused'); },
      describe: async () => ({ workspaceId, contentMode: 'e2ee', contentModeVersion: 1, genesisHash, cryptoOrgId: genesisHash, activation: 'control-only' }),
      history: async (request) => {
        pagesRead.push(request.cursor);
        if (request.cursor === 'page-2') await continueSync.promise;
        return { workspaceId, genesisHash, checkpoint: { headHash: genesisHash, length: 1 }, startIndex: 1, recordsHex: [], position: local.status.position!, nextCursor: request.cursor === 'page-3' ? null : request.cursor === 'page-2' ? 'page-3' : 'page-2' };
      },
      runtime: {
        recordCreated: async () => {}, open: async () => local.status, close: async () => {}, status: async () => local.status,
        ingestLedgerRecords: async () => { phase++; return { ...local.status, ...(upgrade && phase === 2 ? { upgradeRequiredAt: 1 } : {}) }; },
        ledgerView: async () => {
          if (phase === 1 || (!upgrade && phase === 2)) throw new Error('incomplete view must not cross IPC');
          publishedPhases.push(phase);
          return { ...local, status: { ...local.status, ...(upgrade && phase === 2 ? { upgradeRequiredAt: 1 } : {}) } };
        }
      }
    };
    const Component = Route.options.component as () => ReturnType<typeof createElement>;
    await act(async () => root.render(createElement(Component)));
    expect(container.textContent).toBe('1');
    expect(pagesRead).toEqual([undefined, 'page-2']);
    await act(async () => { continueSync.resolve(); });
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
] as const)('keeps read-only verification for %s (pin=%s, at=%s, mismatched pin=%s)', async (code, pinned, at, mismatch) => {
  if (pinned) saveE2eeGenesisPin(localStorage, 'account', workspaceId, mismatch ? 'a'.repeat(64) : genesisHash);
  const fetched: string[] = [];
  fixture.port = {
    create: async () => { throw new Error('unused'); },
    describe: async () => {
      fetched.push('describe');
      return { workspaceId, contentMode: 'e2ee', contentModeVersion: 1, genesisHash, cryptoOrgId: genesisHash, activation: 'control-only' };
    },
    history: async () => ({ workspaceId, genesisHash, checkpoint: { headHash: genesisHash, length: 1 }, startIndex: 0, recordsHex: [raw], position: local.status.position!, nextCursor: null }),
    runtime: {
      recordCreated: async () => { if (at === 'recordCreated') throw new Error(`e2ee_${code}`); },
      open: async () => { throw new Error(`Error invoking remote method 'e2ee:open': Error: e2ee_${code}`); },
      close: async () => {},
      status: async () => local.status,
      ledgerView: async () => { throw new Error('native view must not be used'); },
      ingestLedgerRecords: async () => { throw new Error('native ingestion must not be used'); },
    },
  };
  const Component = Route.options.component as () => ReturnType<typeof createElement>;
  await act(async () => root.render(createElement(Component)));
  const availability = ['custody_unavailable', 'account_unavailable', 'missing-binding', 'closed'].includes(code);
  expect(container.textContent).toBe(availability && !mismatch ? '1' : 'failed');
  expect(fetched).toEqual(availability ? ['describe'] : []);
});
