// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPersonalGitHubProof,
  storePersonalGitHubProof,
  takePersonalGitHubCallback,
} from '../src/components/settings/github-personal-authorization';

describe('personal GitHub browser proof', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    sessionStorage.clear();
    window.history.replaceState(null, '', '/team/settings/github');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });
  function callback(payload: unknown) {
    window.history.replaceState(
      null,
      '',
      `/team/settings/github#github-personal=${encodeURIComponent(JSON.stringify(payload))}`
    );
  }
  it('keeps the PKCE secret in this tab and consumes the matching return once', async () => {
    const proof = await createPersonalGitHubProof();
    expect(proof.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const digest = await webcrypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(proof.verifier)
    );
    expect(proof.challenge).toBe(Buffer.from(digest).toString('base64url'));
    storePersonalGitHubProof('state', proof.verifier);
    callback({ state: 'state', code: 'temporary-code' });
    expect(takePersonalGitHubCallback()).toEqual({
      state: 'state',
      code: 'temporary-code',
      verifier: proof.verifier,
    });
    expect(window.location.hash).toBe('');
    expect(sessionStorage.length).toBe(0);
    expect(takePersonalGitHubCallback()).toBeNull();
  });
  it.each(['missing-proof', 'wrong-state', 'denied', 'invalid-json'])(
    'rejects %s and removes callback credentials from history',
    (kind) => {
      if (kind !== 'missing-proof') storePersonalGitHubProof('state', 'secret');
      callback(
        kind === 'denied'
          ? { state: 'state', code: null, error: 'access_denied' }
          : { state: kind === 'wrong-state' ? 'other' : 'state', code: 'code' }
      );
      if (kind === 'invalid-json') window.location.hash = '#github-personal=%7B';
      expect(() => takePersonalGitHubCallback()).toThrow();
      expect(window.location.hash).toBe('');
      expect(sessionStorage.length).toBe(0);
    }
  );
});
