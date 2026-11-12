// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  createPreparedE2eeWorkspace,
  canDiscardPendingCreation,
  canResumePendingCreation,
  clearConfirmedPendingCreation,
  e2eeCreationAvailability,
  e2eeCreationIntent,
  pendingCreationRemoved,
} from '../src/lib/create-e2ee-workspace';
import type { PlatformE2eeWorkspaces } from '@lody/platform';
import {
  clearPendingE2eeWorkspace,
  hasPendingE2eeCreationForSlug,
  listPendingE2eeWorkspaces,
  listPendingE2eeWorkspacesByArchive,
  readE2eeGenesisPin,
  savePendingE2eeWorkspace,
  setPendingE2eeWorkspaceArchived,
} from '../src/lib/e2ee-workspace-storage';

describe('encrypted creation intent recovery', () => {
  it('reuses the saved request instead of minting a second device identity', () => {
    const pending = {
      accountId: 'account-A',
      requestId: 'saved-request-01',
      name: 'Saved workspace',
      slug: 'saved-slug',
    };
    expect(e2eeCreationIntent('account-A', pending, 'Edited name', 'edited-slug')).toEqual(pending);
  });

  it('creates one request only when no pending intent exists', () => {
    const first = e2eeCreationIntent('account-A', null, ' Fresh ', 'fresh');
    const second = e2eeCreationIntent('account-A', first, 'Other', 'other');
    expect(first).toMatchObject({ accountId: 'account-A', name: 'Fresh', slug: 'fresh' });
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toEqual(first);
  });
});

describe('encrypted creation resume checks', () => {
  const pending = {
    accountId: 'account-A',
    requestId: 'saved-request-01',
    name: 'Saved workspace',
    slug: 'saved-slug',
  };

  it('does not re-apply the free-slot or slug checks to a submitted request', () => {
    expect(e2eeCreationAvailability(pending, { canCreateFree: false })).toEqual({
      resumable: true,
      canCreate: true,
      blocked: false,
      slugCheckApplies: false,
    });
  });

  it('still applies both checks to a fresh workspace', () => {
    expect(e2eeCreationAvailability(null, { canCreateFree: false })).toEqual({
      resumable: false,
      canCreate: false,
      blocked: true,
      slugCheckApplies: true,
    });
  });
});

describe('discarding a pending creation', () => {
  it('clears the saved request so the form can start fresh', () => {
    const pending = {
      accountId: 'account-A',
      requestId: 'saved-request-discard',
      name: 'Saved workspace',
      slug: 'saved-slug',
    };
    localStorage.clear();
    savePendingE2eeWorkspace(localStorage, pending);
    expect(listPendingE2eeWorkspaces(localStorage, 'account-A')).toHaveLength(1);
    clearPendingE2eeWorkspace(localStorage, pending);
    expect(listPendingE2eeWorkspaces(localStorage, 'account-A')).toHaveLength(0);
  });
});

describe('pending creation account ownership', () => {
  const pending = {
    accountId: 'account-A',
    requestId: 'saved-request-01',
    name: 'Saved workspace',
    slug: 'saved-slug',
  };

  it('only resumes and discards for the saved account', () => {
    expect(canResumePendingCreation(pending, 'account-A')).toBe(true);
    expect(canResumePendingCreation(pending, 'account-B')).toBe(false);
    expect(canResumePendingCreation(pending, null)).toBe(false);
    expect(canDiscardPendingCreation(false, pending, 'account-B')).toBe(false);
  });

  it('disables discard while a submit is creating', () => {
    expect(canDiscardPendingCreation(false, pending, 'account-A')).toBe(true);
    expect(canDiscardPendingCreation(true, pending, 'account-A')).toBe(false);
  });
});

describe('pending removal and destructive confirmation', () => {
  const pending = {
    accountId: 'account-A',
    requestId: 'saved-request-remove',
    name: 'Saved workspace',
    slug: 'saved-slug',
  };

  it('reports removal only after storage no longer holds the request', () => {
    localStorage.clear();
    savePendingE2eeWorkspace(localStorage, pending);
    expect(pendingCreationRemoved(localStorage, 'account-A', pending.requestId)).toBe(false);
    clearPendingE2eeWorkspace(localStorage, pending);
    expect(pendingCreationRemoved(localStorage, 'account-A', pending.requestId)).toBe(true);
  });

  it('does not clear the request until the discard is confirmed', () => {
    localStorage.clear();
    savePendingE2eeWorkspace(localStorage, pending);
    expect(clearConfirmedPendingCreation(localStorage, pending, false)).toBe(false);
    expect(listPendingE2eeWorkspaces(localStorage, 'account-A')).toHaveLength(1);
    expect(clearConfirmedPendingCreation(localStorage, pending, true)).toBe(true);
    expect(listPendingE2eeWorkspaces(localStorage, 'account-A')).toHaveLength(0);
  });
});

describe('archiving saved creation requests', () => {
  const first = {
    accountId: 'account-A',
    requestId: 'request-1',
    name: 'First',
    slug: 'first',
  };
  const second = { ...first, requestId: 'request-2', name: 'Second', slug: 'second' };

  it('treats requests saved before archiving existed as active', () => {
    localStorage.clear();
    // The exact bytes an earlier client wrote, with no archive field or marker.
    localStorage.setItem(
      'lody-e2ee-pending-creation:account-A:request-1',
      JSON.stringify({
        accountId: 'account-A',
        requestId: 'request-1',
        name: 'First',
        slug: 'first',
      })
    );
    expect(listPendingE2eeWorkspacesByArchive(localStorage, 'account-A')).toEqual({
      active: [first],
      archived: [],
    });
  });

  it('archives one request independently and keeps its original record byte for byte', () => {
    localStorage.clear();
    savePendingE2eeWorkspace(localStorage, first);
    savePendingE2eeWorkspace(localStorage, second);
    const original = localStorage.getItem('lody-e2ee-pending-creation:account-A:request-1');
    setPendingE2eeWorkspaceArchived(localStorage, first, true);
    expect(listPendingE2eeWorkspacesByArchive(localStorage, 'account-A')).toEqual({
      active: [second],
      archived: [first],
    });
    expect(localStorage.getItem('lody-e2ee-pending-creation:account-A:request-1')).toBe(original);
    // An archived request may still own its slug on the server.
    expect(hasPendingE2eeCreationForSlug(localStorage, 'account-A', 'first')).toBe(true);
    // Saving the same intent again (an exact retry) does not un-archive or change it.
    savePendingE2eeWorkspace(localStorage, first);
    expect(listPendingE2eeWorkspacesByArchive(localStorage, 'account-A').archived).toEqual([first]);
    setPendingE2eeWorkspaceArchived(localStorage, first, false);
    expect(listPendingE2eeWorkspacesByArchive(localStorage, 'account-A')).toEqual({
      active: [first, second],
      archived: [],
    });
  });

  it('keeps archives per account', () => {
    localStorage.clear();
    const other = { ...first, accountId: 'account-B' };
    savePendingE2eeWorkspace(localStorage, first);
    savePendingE2eeWorkspace(localStorage, other);
    setPendingE2eeWorkspaceArchived(localStorage, first, true);
    expect(listPendingE2eeWorkspacesByArchive(localStorage, 'account-B')).toEqual({
      active: [other],
      archived: [],
    });
    // Another account cannot archive a request it does not own.
    localStorage.removeItem('lody-e2ee-pending-creation:account-B:request-1');
    expect(() => setPendingE2eeWorkspaceArchived(localStorage, other, true)).toThrow();
    expect(listPendingE2eeWorkspacesByArchive(localStorage, 'account-A').archived).toEqual([first]);
  });

  it('refuses to archive a request whose saved fields differ', () => {
    localStorage.clear();
    savePendingE2eeWorkspace(localStorage, first);
    expect(() =>
      setPendingE2eeWorkspaceArchived(localStorage, { ...first, slug: 'other' }, true)
    ).toThrow('Creation intent changed');
    expect(listPendingE2eeWorkspacesByArchive(localStorage, 'account-A').archived).toEqual([]);
  });

  it('completes an archived request whose late result succeeded and leaves no archive row', async () => {
    localStorage.clear();
    savePendingE2eeWorkspace(localStorage, first);
    savePendingE2eeWorkspace(localStorage, second);
    setPendingE2eeWorkspaceArchived(localStorage, first, true);
    setPendingE2eeWorkspaceArchived(localStorage, second, true);
    const hash = 'cd'.repeat(32);
    const port = {
      prepareCreation: async (input: typeof first) => ({
        ...input,
        genesisRecordHex: 'aa',
        genesisHashHex: hash,
        deviceCredentialHash: 'ee',
      }),
      create: async () => ({
        workspaceId: 'workspace-1',
        name: first.name,
        slug: first.slug,
        contentMode: 'e2ee' as const,
        contentModeVersion: 1 as const,
        genesisHash: hash,
        cryptoOrgId: hash,
        activation: 'control-only' as const,
      }),
    } as unknown as PlatformE2eeWorkspaces;
    const created = await createPreparedE2eeWorkspace(port, localStorage, first);
    expect(created.workspaceId).toBe('workspace-1');
    expect(readE2eeGenesisPin(localStorage, 'account-A', 'workspace-1')).toBe(hash);
    // The completed request leaves both lists; the other archived request is untouched.
    expect(listPendingE2eeWorkspacesByArchive(localStorage, 'account-A')).toEqual({
      active: [],
      archived: [second],
    });
    expect(
      localStorage.getItem('lody-e2ee-pending-creation-archived:account-A:request-1')
    ).toBeNull();
  });
});
