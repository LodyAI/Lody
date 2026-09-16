import { describe, expect, it } from 'vitest';
import { generateDevice } from '../src/device';
import type { DemoKv } from '../src/persist';
import { BrowserSession } from '../src/ui/browser-session';
import { launchHost } from './helpers';

function memoryKv(): DemoKv & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
  };
}

function journalPending(kv: DemoKv): string | null {
  const raw = kv.getItem('journal');
  if (!raw) return null;
  return (JSON.parse(raw) as { pending: string | null }).pending;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  const value = input as { href?: unknown; url?: unknown };
  if (typeof value.href === 'string') return value.href;
  if (typeof value.url === 'string') return value.url;
  return String(input);
}

function isHostControlCas(input: RequestInfo | URL, baseUrl: string): boolean {
  const url = requestUrl(input);
  return url.startsWith(baseUrl) && url.includes('/control/append-cas');
}

describe('browser persistence', () => {
  it('restores the same device, genesis, and epoch keys after a new session for the same account', async () => {
    const host = await launchHost();
    const first = new BrowserSession(host.baseUrl, 'persist-browser');
    await first.start();
    await first.createSpace();
    const reloaded = new BrowserSession(host.baseUrl, 'persist-browser');
    await reloaded.start();
    expect(Buffer.from(first.device.publicKey).equals(Buffer.from(reloaded.device.publicKey))).toBe(
      true
    );
    expect(reloaded.genesisHex).toBe(first.genesisHex);
    expect(reloaded.epochKeys.size).toBeGreaterThan(0);
    expect(
      Buffer.from(reloaded.epochKeys.get(0)!).equals(Buffer.from(first.epochKeys.get(0)!))
    ).toBe(true);
  });

  it('resumes a dropped-ACK pending record after reopening the same account', async () => {
    const host = await launchHost();
    const alice = new BrowserSession(host.baseUrl, 'persist-ack');
    await alice.start();
    await alice.createSpace();
    await fetch(`${host.baseUrl}/v1/failpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'drop-control-ack' }),
    });
    const extra = await generateDevice();
    await alice.admitDevice(extra, 'personal', false).catch(() => undefined);
    await fetch(`${host.baseUrl}/v1/failpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'none' }),
    });
    const reopened = new BrowserSession(host.baseUrl, 'persist-ack');
    await reopened.start();
    let ledger = await reopened.readLedger();
    if (ledger.length < 2) {
      const result = await reopened.resume();
      expect(result.status).toBe('committed');
      ledger = await reopened.readLedger();
    }
    expect(ledger.length).toBe(2);
    expect(ledger.state.devices.size).toBe(2);
  });

  it('persists pending before the CAS request is sent so a reopen can resume without re-signing', async () => {
    const host = await launchHost();
    const kv = memoryKv();
    const alice = new BrowserSession(host.baseUrl, 'persist-before-cas', kv);
    await alice.start();
    await alice.createSpace();
    const extra = await generateDevice();
    const originalFetch = globalThis.fetch;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const atCas = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let casCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isHostControlCas(input, host.baseUrl)) {
        casCalls += 1;
        if (casCalls === 1) {
          reached();
          await hold;
        }
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const inflight = alice.admitDevice(extra, 'personal', false);
      await atCas;
      const pendingHex = journalPending(kv);
      expect(pendingHex).toEqual(expect.any(String));
      expect(casCalls).toBe(1);
      const reopened = new BrowserSession(host.baseUrl, 'persist-before-cas', kv);
      await reopened.start();
      const resumed = await reopened.resume();
      expect(resumed.status).toBe('committed');
      expect((await reopened.readLedger()).length).toBe(2);
      expect((await reopened.readLedger()).state.devices.size).toBe(2);
      release();
      const first = await inflight;
      expect(first.status === 'committed' || first.status === 'conflict').toBe(true);
      expect((await reopened.readLedger()).length).toBe(2);
    } finally {
      release();
      globalThis.fetch = originalFetch;
    }
  });

  it('recovers a committed record if the client closes after CAS succeeds but before the response is delivered', async () => {
    const host = await launchHost();
    const kv = memoryKv();
    const alice = new BrowserSession(host.baseUrl, 'persist-after-cas', kv);
    await alice.start();
    await alice.createSpace();
    const extra = await generateDevice();
    const originalFetch = globalThis.fetch;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const atResponse = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let casCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isHostControlCas(input, host.baseUrl)) {
        casCalls += 1;
        const response = await originalFetch(input, init);
        if (casCalls === 1) {
          expect(journalPending(kv)).toEqual(expect.any(String));
          reached();
          await hold;
        }
        return response;
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const inflight = alice.admitDevice(extra, 'personal', false);
      await atResponse;
      const reopened = new BrowserSession(host.baseUrl, 'persist-after-cas', kv);
      await reopened.start();
      const resumed = await reopened.resume();
      expect(resumed.status).toBe('committed');
      expect((await reopened.readLedger()).length).toBe(2);
      expect((await reopened.readLedger()).state.devices.size).toBe(2);
      release();
      const first = await inflight;
      expect(first.status === 'committed' || first.status === 'conflict').toBe(true);
      expect((await reopened.readLedger()).length).toBe(2);
    } finally {
      release();
      globalThis.fetch = originalFetch;
    }
  });

  it('does not send CAS if pending cannot be persisted', async () => {
    const host = await launchHost();
    const data = new Map<string, string>();
    let rejectPending = false;
    const kv: DemoKv = {
      getItem(key) {
        return data.get(key) ?? null;
      },
      setItem(key, value) {
        if (rejectPending && key === 'journal') {
          const pending = (JSON.parse(value) as { pending: string | null }).pending;
          if (pending) throw new Error('persist-failed');
        }
        data.set(key, value);
      },
    };
    const alice = new BrowserSession(host.baseUrl, 'persist-fail-cas', kv);
    await alice.start();
    await alice.createSpace();
    rejectPending = true;
    const originalFetch = globalThis.fetch;
    let casCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isHostControlCas(input, host.baseUrl)) casCalls += 1;
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      await expect(alice.admitDevice(await generateDevice(), 'personal', false)).rejects.toThrow(
        'persist-failed'
      );
      expect(casCalls).toBe(0);
      expect((await alice.readLedger()).length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
