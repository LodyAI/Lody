import { describe, expect, it } from 'vitest';
import { e2eeCreationIntent } from '../src/lib/create-e2ee-workspace';

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
