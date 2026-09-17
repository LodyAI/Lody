import { afterEach, describe, expect, it } from 'vitest';
import { generateDevice } from '../src/platform/device';
import { recordingEntropy } from '../src/entropy';
import { cleanupLab, labClient, launchLab } from '../src/fixtures';
import { LabRuntime } from '../src/runtime';

afterEach(() => cleanupLab());

describe('P2 permit runtime', () => {
  it('does not send CAS until permitted and can pause one actor', async () => {
    const runtime = new LabRuntime({ mode: 'manual' });
    const host = await launchLab();
    const entropy = recordingEntropy();
    const alice = await labClient({ host, account: 'alice', runtime, entropy });
    const twin = await labClient({
      host,
      account: 'twin',
      runtime,
      entropy,
      device: undefined,
    });
    await alice.createSpace();
    twin.device = alice.device;
    await twin.reauth();
    await twin.adoptGenesis(alice.genesisHex!);
    const extra = await generateDevice();
    const other = await generateDevice();
    runtime.pause('twin');
    const aliceSubmit = alice.admitDevice(extra, 'personal', false);
    const twinSubmit = twin.admitDevice(other, 'personal', false);
    await runtime.whenRequested(2);
    expect(
      runtime.events().some((event) => event.actor === 'twin' && event.status === 'permitted')
    ).toBe(false);
    runtime.permitActor('alice');
    const aliceResult = await aliceSubmit;
    expect(aliceResult.status).toBe('committed');
    runtime.resumeActor('twin');
    runtime.permitActor('twin');
    const twinResult = await twinSubmit;
    expect(twinResult.status).toBe('conflict');
    expect((await alice.readLedger()).state.devices.size).toBe(2);
  });
});
