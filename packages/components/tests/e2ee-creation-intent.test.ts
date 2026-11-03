// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { e2eeCreationAvailability, e2eeCreationIntent } from '../src/lib/create-e2ee-workspace';
import {
  clearPendingE2eeWorkspace,
  listPendingE2eeWorkspaces,
  savePendingE2eeWorkspace,
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
