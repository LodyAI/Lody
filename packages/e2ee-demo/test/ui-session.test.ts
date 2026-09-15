import { describe, expect, it } from 'vitest';
import { readLoro, writeLoro } from '../src/content-session';
import { BrowserSession } from '../src/ui/browser-session';
import { launchHost } from './helpers';

async function browser(host: { baseUrl: string }, account: string): Promise<BrowserSession> {
  const client = new BrowserSession(host.baseUrl, account);
  await client.start();
  return client;
}

describe('UI session class against the real host', () => {
  it('delivers keys, writes Loro, restores from a backup file, and revokes', async () => {
    const host = await launchHost();
    const alice = await browser(host, 'alice');
    const bob = await browser(host, 'bob');
    const genesis = await alice.createSpace();
    await bob.requestJoin(genesis);
    await alice.approveFirstJoin();
    expect(await alice.deliverToOthers()).toBeGreaterThan(0);
    expect(await bob.receivePendingKeys()).toBeGreaterThan(0);
    await writeLoro(alice, 'ui-session-secret');
    expect(await readLoro(bob)).toContain('ui-session-secret');
    const backup = await alice.exportRecoveryFile();
    const restored = await browser(host, 'alice-phone');
    await restored.restoreRecoveryFile(backup);
    expect(await readLoro(restored)).toContain('ui-session-secret');
    await alice.revokeFirstOtherMember();
    await expect(writeLoro(bob, 'after-revoke')).rejects.toThrow();
  });
});
