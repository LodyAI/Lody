import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BoundaryDecodeError,
  decodeBetterAuthActiveOrganization,
  decodeBetterAuthOrganizations,
  decodeBetterAuthSession,
  decodeExternalList,
  decodeExternalObject,
  decodeNullableExternalObject,
  formatBoundaryDecodeDiagnostic,
  type BoundaryDecodeDiagnostic,
} from '../src/boundary-decode';

describe('boundary-decode', () => {
  it('drops null and malformed list elements while keeping valid items and sanitized diagnostics', () => {
    const diagnostics: BoundaryDecodeDiagnostic[] = [];
    const schema = z.object({ id: z.string().min(1), name: z.string() });
    const raw = [
      null,
      { id: 'org-1', name: 'Valid One' },
      { id: '', name: 'secret-token-should-not-appear' },
      undefined,
      { id: 'org-2', name: 'Valid Two' },
    ];

    const result = decodeExternalList('test.orgs', schema, raw, {
      onDiagnostic: (d) => diagnostics.push(d),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([
        { id: 'org-1', name: 'Valid One' },
        { id: 'org-2', name: 'Valid Two' },
      ]);
      expect(result.droppedCount).toBe(3);
    }
    expect(diagnostics).toHaveLength(1);
    const formatted = formatBoundaryDecodeDiagnostic(diagnostics[0]!);
    expect(formatted).toContain('boundary=test.orgs');
    expect(formatted).toContain('dropped=3/5');
    expect(formatted).not.toContain('secret-token-should-not-appear');
  });

  it('rejects non-array list payloads with BoundaryDecodeError', () => {
    const schema = z.object({ id: z.string().min(1) });
    const result = decodeExternalList('test.orgs', schema, { id: 'not-an-array' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(BoundaryDecodeError);
      expect(result.error.boundary).toBe('test.orgs');
    }
  });

  it('decodes nullable single objects cleanly and rejects half-formed payloads', () => {
    const schema = z.object({ id: z.string().min(1) });
    expect(decodeNullableExternalObject('test.single', schema, null)).toEqual({
      ok: true,
      data: null,
    });
    expect(decodeNullableExternalObject('test.single', schema, undefined)).toEqual({
      ok: true,
      data: null,
    });
    const invalid = decodeExternalObject('test.single', schema, { id: '' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error).toBeInstanceOf(BoundaryDecodeError);
    }
  });

  it('sanitizes Better Auth organization lists, active org members, and session payloads', () => {
    const orgs = decodeBetterAuthOrganizations('betterAuth.list', [
      null,
      { id: 'ws-1', slug: 'alpha', name: 'Alpha', contentMode: 'plaintext' },
      { slug: 'missing-id' },
    ]);
    expect(orgs.ok).toBe(true);
    if (orgs.ok) {
      expect(orgs.data).toEqual([
        { id: 'ws-1', slug: 'alpha', name: 'Alpha', contentMode: 'plaintext' },
      ]);
    }

    const active = decodeBetterAuthActiveOrganization('betterAuth.active', {
      id: 'ws-1',
      slug: 'alpha',
      members: [null, { userId: 'u-1', role: 'owner' }, { role: 'member' }],
    });
    expect(active.ok).toBe(true);
    if (active.ok) {
      expect(active.data?.members).toEqual([{ userId: 'u-1', role: 'owner' }]);
    }

    const badSession = decodeBetterAuthSession('betterAuth.session', {
      user: { email: 'missing-id@example.test' },
    });
    expect(badSession.ok).toBe(false);
  });
});
