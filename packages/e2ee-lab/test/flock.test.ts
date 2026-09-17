import { afterEach, describe, expect, it } from 'vitest';
import { readFlock, writeFlock, writeLoro } from '../src/platform/content-session';
import { cleanupLab, labClient, launchLab } from '../src/fixtures';

afterEach(() => cleanupLab());

describe('lab Flock and Loro content', () => {
  it('writes encrypted Flock and Loro values that round-trip', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    await alice.createSpace();
    await alice.readLedger();
    await writeLoro(alice, 'loro-lab');
    await writeFlock(alice, 'flock-lab');
    expect(await readFlock(alice)).toContain('flock-lab');
  });
});
