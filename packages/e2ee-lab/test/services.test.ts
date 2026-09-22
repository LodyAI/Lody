import { afterEach, describe, expect, it } from 'vitest';
import { Layer } from 'effect';
import { createAttackLab } from '../src/attack-lab';
import { LabRuntime } from '../src/runtime';
import {
  LiveLabClock,
  LiveLabHttp,
  MemoryLabFs,
  TestLabClock,
  makeTestClock,
} from '../src/services';
import { cleanupLab, labClient, launchLab } from '../src/fixtures';
import type { LabBackend } from '../src/backend';
import { liveEntropy } from '@lody/e2ee-core';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

afterEach(() => cleanupLab());

function withDbPath(host: LabBackend, riverrunDbPath: string): LabBackend {
  return {
    baseUrl: host.baseUrl,
    riverrunUrl: host.riverrunUrl,
    dataDir: host.dataDir,
    port: host.port,
    riverrunDbPath,
    harnessToken: host.harnessToken,
    setNow: (value) => host.setNow(value),
    setFailpoint: (name) => host.setFailpoint(name),
    close: () => host.close(),
  };
}

describe('Lab services', () => {
  it('preserves entropy replay defects without creating a candidate or changing the ledger', async () => {
    const host = await launchLab();
    const defect = new Error('entropy-mismatch:synthetic');
    let fail = false;
    const client = await labClient({
      host,
      account: 'alice',
      entropy: {
        fill(label, bytes) {
          if (fail) throw defect;
          return liveEntropy.fill(label, bytes);
        },
      },
    });
    await client.createSpace();
    fail = true;
    // Effect span annotations may copy the Error; preserve its diagnostic, not object identity.
    await expect(client.publishEpoch()).rejects.toThrow('entropy-mismatch:synthetic');
    expect(existsSync(join(client.clientDir, 'epoch-candidate.json'))).toBe(false);
    expect((await client.readLedger()).state.epoch.number).toBe(0);
    expect([...client.epochKeys.keys()]).toEqual([0]);
  });

  it('fails attack-budget-time from LabClock without wall Date.now', async () => {
    const clock = makeTestClock(1_000);
    const memory = MemoryLabFs({ '/tmp/fake-riverrun.sqlite': new Uint8Array([1, 2, 3]) });
    const layer = Layer.mergeAll(TestLabClock(clock), memory, LiveLabHttp);
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const lab = createAttackLab({
      host: withDbPath(host, '/tmp/fake-riverrun.sqlite'),
      runtime,
      clientDirs: ['/tmp/client-a'],
      expectedPlaintext: 'none',
      genesisHex: 'aa'.repeat(32),
      maxMs: 100,
      layer,
    });
    clock.advance(200);
    await expect(lab.observe()).rejects.toThrow('attack-budget-time');
  });

  it('readBackend uses LabFs and rejects client-dir targets', async () => {
    const memory = MemoryLabFs({
      '/lab/backend.sqlite': new Uint8Array([9, 9, 9]),
      '/lab/client/secret': new Uint8Array([1]),
    });
    const layer = Layer.mergeAll(LiveLabClock, memory, LiveLabHttp);
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const lab = createAttackLab({
      host: withDbPath(host, '/lab/backend.sqlite'),
      runtime,
      clientDirs: ['/lab/client'],
      expectedPlaintext: 'none',
      genesisHex: 'bb'.repeat(32),
      layer,
    });
    const bytes = await lab.readBackend({ target: 'riverrun', eventId: 'barrier' });
    expect([...bytes]).toEqual([9, 9, 9]);

    const blocked = createAttackLab({
      host: withDbPath(host, '/lab/client/secret'),
      runtime: new LabRuntime({ mode: 'auto' }),
      clientDirs: ['/lab/client'],
      expectedPlaintext: 'none',
      genesisHex: 'bb'.repeat(32),
      layer,
    });
    await expect(blocked.readBackend({ target: 'riverrun', eventId: 'barrier' })).rejects.toThrow(
      'invalid-target'
    );
  });

  it('LabRuntime gatedFetch uses the injected fetchImpl', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return new Response('ok', { status: 200 });
    };
    const runtime = new LabRuntime({ mode: 'auto', fetch: fetchImpl });
    const result = await runtime.gatedFetch('alice')('http://127.0.0.1/healthz');
    expect(result.status).toBe(200);
    expect(calls.some((url) => url.includes('/healthz'))).toBe(true);
  });

  it('mutateBackend xors through LabFs without touching node:fs for the needle path', async () => {
    const body = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
    const memory = MemoryLabFs({ '/lab/rr.sqlite': body });
    const layer = Layer.mergeAll(LiveLabClock, memory, LiveLabHttp);
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    const facade: LabBackend = {
      baseUrl: host.baseUrl,
      riverrunUrl: host.riverrunUrl,
      dataDir: host.dataDir,
      port: host.port,
      riverrunDbPath: '/lab/rr.sqlite',
      harnessToken: host.harnessToken,
      setNow: (value) => host.setNow(value),
      setFailpoint: (name) => host.setFailpoint(name),
      close: async () => undefined,
    };
    const lab = createAttackLab({
      host: facade,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'none',
      genesisHex: alice.genesisHex,
      layer,
    });
    const ok = await lab.mutateBackend({
      eventId: 'barrier',
      kind: 'xor',
      needleHex: '2030',
      xor: 0xff,
    });
    expect(ok).toEqual({ ok: true });
    expect([...memory.fs.readBytes('/lab/rr.sqlite')]).toEqual([0x10, 0xdf, 0x30, 0x40]);
  });
});
