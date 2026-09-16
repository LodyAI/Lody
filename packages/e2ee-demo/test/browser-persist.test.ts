import { describe, expect, it } from 'vitest';
import { generateDevice } from '../src/device';
import { BrowserSession } from '../src/ui/browser-session';
import { launchHost } from './helpers';

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
});
