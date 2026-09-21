import { describe, expect, it } from 'vitest';
import { LedgerClient, MemoryLedgerStore, MemoryLedgerStream } from '../src/ledger';
import { admitDeviceOp, append, buildMixedChain, ed25519 } from './ledger-fixtures';

describe('L4 opaque paged two-client reconcile', () => {
  it('catches up a lagging client through opaque page offsets without taking a fork', async () => {
    const { owner, created, records } = await buildMixedChain(12);
    const suffix = records.slice(1);
    expect(suffix.length).toBeGreaterThan(8);

    const stream = new MemoryLedgerStream();
    stream.pageSize = 2;
    const leader = await LedgerClient.open(created.record, new MemoryLedgerStore(), stream);
    for (const record of suffix) {
      const result = await leader.submit(record);
      expect(result.status).toBe('committed');
    }
    const leadView = await leader.read();
    expect(leadView.length).toBe(records.length);
    expect(stream.records.length).toBe(suffix.length);

    const followerStore = new MemoryLedgerStore();
    const follower = await LedgerClient.open(created.record, followerStore, stream);
    const behind = await follower.read();
    expect(behind.head).toEqual(leadView.head);
    expect(behind.length).toBe(leadView.length);
    for (let i = 0; i < leadView.length; i++) {
      expect(behind.hashAt(i)).toEqual(leadView.hashAt(i));
    }
    expect(followerStore.journal?.offset.startsWith('opaque:')).toBe(true);
    expect(followerStore.journal?.offset).toBe(`opaque:${suffix.length}/+`);

    const extra = records[records.length - 1]!;
    expect((await follower.submit(extra)).status).toBe('committed');

    const competing = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal', true)
    );
    const late = await LedgerClient.open(created.record, new MemoryLedgerStore(), stream);
    const conflict = await late.submit(competing.record);
    expect(conflict.status).toBe('conflict');
    const otherHead = await late.read();
    expect(otherHead.head).toEqual(leadView.head);
    expect(otherHead.length).toBe(leadView.length);
  });

  it('does not adopt a longer unverified fork advertised only as a remote head', async () => {
    const { created, records } = await buildMixedChain(6);
    const stream = new MemoryLedgerStream();
    stream.pageSize = 3;
    const a = await LedgerClient.open(created.record, new MemoryLedgerStore(), stream);
    for (const record of records.slice(1)) {
      expect((await a.submit(record)).status).toBe('committed');
    }
    const verified = await a.read();
    const b = await LedgerClient.open(created.record, new MemoryLedgerStore(), stream);
    const caught = await b.read();
    expect(caught.summary()).toEqual(verified.summary());
    expect(caught.state.devices.size).toBe(verified.state.devices.size);
    const claimed = {
      genesis: verified.summary().genesis,
      length: verified.length + 10,
      head: records[0]!,
    };
    expect(caught.length).not.toBe(claimed.length);
    expect(caught.head).toEqual(verified.head);
  });
});
