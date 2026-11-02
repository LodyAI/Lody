import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Result } from 'effect';
import {
  Bytes,
  exportVerifiedState,
  verifyLedger,
  hashRecordBytes,
} from '@lody/e2ee-core/protocol';
import type { E2eeRuntimeLedgerView, PlatformE2eeWorkspaces } from '@lody/platform';
import vector from '../../../e2ee-core/test/ledger-v1-vector.json';
import { Route } from '../../src/routes/workspace/e2ee/$workspaceId';
import { fixture } from './e2ee-control-route-ports';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g)!, (byte) => Number.parseInt(byte, 16));
const hex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
const anchor = Result.getOrThrow(Bytes.genesisHash(bytes(vector.anchor)));
const state = Result.getOrThrow(
  exportVerifiedState(
    Result.getOrThrow(
      verifyLedger({
        anchor,
        records: [bytes(vector.records[0].hex)],
        checkpoint: { head: hashRecordBytes(bytes(vector.records[0].hex)), length: 1 },
      })
    )
  )
);
fixture.genesisHash = vector.anchor;
const local: E2eeRuntimeLedgerView = {
  stateHex: hex(state.bytes),
  recordsHex: [vector.records[0].hex],
  status: {
    workspaceId: fixture.workspaceId,
    genesisHash: vector.anchor,
    headHash: vector.anchor,
    length: 1,
    stateDigest: hex(state.stateDigest.toBytes()),
    epoch: 0,
    rotationRequired: false,
    deviceKind: 'personal',
    hasCurrentKey: true,
    continuityPending: false,
  },
};

/** Explicit public/native gates; no timers, polling, stack or actual remote service. */
export async function reopen(paused: 'describe' | 'history') {
  const descriptor = {
    workspaceId: fixture.workspaceId,
    contentMode: 'e2ee' as const,
    contentModeVersion: 1 as const,
    genesisHash: vector.anchor,
    cryptoOrgId: vector.anchor,
    activation: 'control-only' as const,
  };
  const page = {
    workspaceId: fixture.workspaceId,
    genesisHash: vector.anchor,
    checkpoint: { headHash: vector.anchor, length: 1 },
    startIndex: 0,
    recordsHex: [vector.records[0].hex],
    position: 'synthetic-public-position',
    nextCursor: null,
  };
  const entered = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const described = Promise.withResolvers<typeof descriptor>();
  const historical = Promise.withResolvers<typeof page>();
  const readers = new Set<string>();
  const ingested: string[][] = [];
  let descriptions = 0,
    histories = 0,
    released = false;
  fixture.port = {
    describe: async () => {
      if (++descriptions === 1 && paused === 'describe') {
        entered.resolve();
        return described.promise;
      }
      return descriptor;
    },
    history: async () => {
      if (++histories === 1 && paused === 'history') {
        entered.resolve();
        return historical.promise;
      }
      return page;
    },
    runtime: {
      readerLeases: 'preallocated-v1',
      recordCreated: async () => {},
      open: async (_workspace, _observed, account, reader) => {
        if (account !== fixture.accountId || !reader) throw new Error('wrong scope or reader');
        readers.add(reader);
        return { ...local.status, readerOwner: reader };
      },
      close: async (_workspace, account, reader) => {
        if (account !== fixture.accountId || !reader) throw new Error('unscoped close');
        readers.delete(reader);
        closed.resolve();
      },
      ledgerView: async () => local,
      ingestLedgerRecords: async (_workspace, received) => {
        ingested.push(received.recordsHex);
        return local.status;
      },
    },
  } as PlatformE2eeWorkspaces;
  fixture.modes = [];
  fixture.checkpoints = [];
  const container = document.createElement('main');
  document.body.append(container);
  let root = createRoot(container);
  const Component = Route.options.component;
  const snapshot = () => ({
    view: container.querySelector('[data-control-state]')?.textContent,
    readers: [...readers],
    publicReleased: released,
    ingested: [...ingested],
    modes: [...fixture.modes],
    checkpoints: [...fixture.checkpoints],
  });
  try {
    await act(async () => root.render(createElement(Component)));
    await entered.promise;
    const localView = snapshot();
    await act(async () => root.unmount());
    await closed.promise;
    const confirmedClose = snapshot();
    root = createRoot(container);
    await act(async () => root.render(createElement(Component)));
    const beforeNetwork = snapshot();
    await act(async () => {
      released = true;
      described.resolve({ ...descriptor, genesisHash: 'ff'.repeat(32) });
      historical.resolve({ ...page, recordsHex: ['00'] });
    });
    return { localView, confirmedClose, beforeNetwork, afterNetwork: snapshot() };
  } finally {
    await act(async () => {
      described.resolve(descriptor);
      historical.resolve(page);
    });
    await act(async () => root.unmount());
    container.remove();
  }
}
