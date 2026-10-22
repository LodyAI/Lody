// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloudApi, PlatformProvider } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { TEST_CLOUD_PLATFORM } from './test-platform';
import { ReferralLeadAttacher } from '../src/components/referral-lead-attacher';
import { captureReferral, readReferral } from '../src/lib/referral-attribution';
function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}
describe('referral attribution through login', () => {
  it('keeps the first valid click through a login redirect and expires after 30 days', () => {
    const s = storage();
    captureReferral('?ref=' + 'a'.repeat(32), s, 1000);
    captureReferral('?ref=' + 'b'.repeat(32), s, 2000);
    captureReferral('?redirect=%2Fworkspace', s, 3000);
    expect(readReferral(s, 4000)).toBe('a'.repeat(32));
    expect(readReferral(s, 1000 + 30 * 86400000)).toBeUndefined();
    captureReferral('?ref=' + 'b'.repeat(32), s, 1000 + 30 * 86400000);
    expect(readReferral(s, 1001 + 30 * 86400000)).toBe('b'.repeat(32));
  });
  it('ignores corrupt values and unavailable storage without blocking login', () => {
    const s = storage();
    s.setItem('lody:referral', '{broken');
    expect(readReferral(s, 1000)).toBeUndefined();
    captureReferral('?ref=https://untrusted.example', s, 1000);
    expect(readReferral(s, 1000)).toBeUndefined();
    const denied = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
      removeItem() {
        throw new Error('denied');
      },
    };
    expect(() => captureReferral('?ref=' + 'a'.repeat(32), denied, 1000)).not.toThrow();
    expect(readReferral(denied, 1000)).toBeUndefined();
  });
  it('tolerates browsers that throw while accessing the localStorage property', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('Storage denied');
      },
    });
    try {
      expect(() => captureReferral('?ref=' + 'a'.repeat(32))).not.toThrow();
      expect(readReferral()).toBeUndefined();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe('referral attachment to the authenticated account', () => {
  const code = 'a'.repeat(32);
  let root: Root;
  let container: HTMLDivElement;
  let activeUser: string | null;
  let platform: PlatformProvider;
  let attach: (
    userId: string,
    code: string
  ) => Promise<{ status: 'attached' | 'kept' | 'self' | 'invalid' }>;
  const leads = new Map<string, string>();

  beforeEach(() => {
    localStorage.clear();
    leads.clear();
    activeUser = null;
    captureReferral(`?ref=${code}`);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    attach = async (userId, referralCode) => {
      leads.set(userId, referralCode);
      return { status: 'attached' };
    };
    const mutation = ({ code: referralCode }: { code: string }) => {
      if (!activeUser) throw new Error('Unauthenticated attachment');
      return attach(activeUser, referralCode);
    };
    platform = {
      ...TEST_CLOUD_PLATFORM,
      cloudApi: {
        ...TEST_CLOUD_PLATFORM.cloudApi!,
        useMutation: (() => mutation) as CloudApi['useMutation'],
      },
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
  });

  async function signIn(userId: string | null) {
    activeUser = userId;
    await act(async () => {
      root.render(
        <PlatformContext.Provider value={platform}>
          <ReferralLeadAttacher userId={userId} />
        </PlatformContext.Provider>
      );
    });
  }

  it('does not let a self-referral or a legacy browser marker suppress another account', async () => {
    localStorage.setItem('lody:referral:attached', code);
    attach = async (userId, referralCode) => {
      if (userId === 'referrer') return { status: 'self' };
      leads.set(userId, referralCode);
      return { status: 'attached' };
    };
    await signIn('referrer');
    expect(leads.size).toBe(0);
    await signIn(null);
    await signIn('newcomer');
    expect(leads.get('newcomer')).toBe(code);
  });

  it('attaches separately when switching directly between authenticated users', async () => {
    await signIn('first');
    await signIn('second');
    expect([...leads]).toEqual([
      ['first', code],
      ['second', code],
    ]);
  });

  it.each(['invalid', 'self', 'failed'] as const)(
    'retries an unconfirmed %s outcome after the identity settles again',
    async (status) => {
      attach = async () => {
        if (status === 'failed') throw new Error('Offline');
        return { status };
      };
      await signIn('newcomer');
      expect(leads.size).toBe(0);
      await signIn(null);
      attach = async (userId, referralCode) => {
        leads.set(userId, referralCode);
        return { status: 'attached' };
      };
      await signIn('newcomer');
      expect(leads.get('newcomer')).toBe(code);
    }
  );

  it('does not reuse a late result from an identity that has signed out', async () => {
    let finishFirst!: () => void;
    attach = (userId, referralCode) => {
      if (userId === 'first') {
        return new Promise((resolve) => {
          finishFirst = () => {
            leads.set(userId, referralCode);
            resolve({ status: 'attached' });
          };
        });
      }
      return Promise.resolve({ status: 'invalid' });
    };
    await signIn('first');
    await signIn('second');
    await act(async () => finishFirst());
    // The server can forget a lead independently. A stale completion must not
    // create a success marker that suppresses the next authenticated attempt.
    leads.delete('first');
    attach = async (userId, referralCode) => {
      leads.set(userId, referralCode);
      return { status: 'attached' };
    };
    await signIn('first');
    expect(leads.get('first')).toBe(code);
  });

  it('never initializes a cloud mutation without billing capability', async () => {
    platform = {
      ...platform,
      kind: 'local',
      capabilities: new Set(),
      cloudApi: {
        ...platform.cloudApi!,
        useMutation: () => {
          throw new Error('Local cloud client initialized');
        },
      },
    };
    await signIn('local-user');
    expect(leads.size).toBe(0);
  });
});
