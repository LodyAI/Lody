import { describe, expect, it, vi } from 'vitest';
import { getMachineFlockDocId } from '../src/machine-flock';
import { getWorkspaceFlockDocId } from '../src/workspace-flock';
import type { MachineId, WorkspaceId } from '../src/ids';
import {
  encryptedWorkspaceRoom,
  createWorkspaceEpochTransitionLegacy,
} from '../src/workspace-streams-content';
import { LoroDoc } from 'loro-crdt';
import {
  StreamsCrdt,
  createLoroDocAdapter,
  createInitialRemoteCursor,
} from '@loro-dev/streams-crdt/loro';

describe('encrypted workspace room domains', () => {
  const workspace = 'room-owner' as WorkspaceId;
  it('accepts the actual shared Meta, session and configuration room identifiers', () => {
    expect(encryptedWorkspaceRoom(workspace, { kind: 'meta' })).toEqual({
      resource: 'meta',
      model: 'flock',
    });
    expect(encryptedWorkspaceRoom(workspace, { kind: 'doc', docId: 'session-id' })).toEqual({
      resource: 'doc:session-id',
      model: 'loro',
    });
    for (const flockDocId of [
      getMachineFlockDocId(workspace, 'local' as MachineId),
      getWorkspaceFlockDocId(workspace),
    ])
      expect(encryptedWorkspaceRoom(workspace, { kind: 'flock', flockDocId })).toEqual({
        resource: `flock:${flockDocId}`,
        model: 'flock',
      });
  });
  it('rejects other workspaces and all unimplemented Flock domains', () => {
    for (const flockDocId of [
      getMachineFlockDocId('other' as WorkspaceId, 'local' as MachineId),
      getWorkspaceFlockDocId('other' as WorkspaceId),
      'wf',
      'mf:local',
      `${workspace}:schedule:registry`,
      `${workspace}:collab:index`,
    ])
      expect(() => encryptedWorkspaceRoom(workspace, { kind: 'flock', flockDocId })).toThrow(
        'Encrypted workspace room is unavailable'
      );
  });
});

// The same gate is consumed at the renderer and machine SDK boundaries.
describe('workspace epoch handoff', () => {
  const status = { epoch: 1, rotationRequired: false, hasCurrentKey: true };
  const request = {
    context: { protocol: 'loro-streams-crdt-payload-protection', version: 2, kind: 'update_batch' },
    plaintext: new Uint8Array([7]),
    additionalData: () => new Uint8Array(),
  } as const;
  const native = () => ({
    maxSealOverheadBytes: 1,
    seal: async () => ({ header: new Uint8Array([3]), sealed: new Uint8Array([9]) }),
    open: async () => new Uint8Array([7]),
  });

  it('discards late old-provider seal and open results, drains, then uses only new providers', async () => {
    const gate = createWorkspaceEpochTransitionLegacy({ epoch: 0 });
    const seal = Promise.withResolvers<{ header: Uint8Array; sealed: Uint8Array }>();
    const open = Promise.withResolvers<Uint8Array>();
    const old = gate.provider(() => ({
      ...native(),
      seal: () => seal.promise,
      open: () => open.promise,
    }));
    const sealed = old.seal(request).then(
      () => 'accepted',
      (error: Error) => error.message
    );
    const opened = old
      .open({
        context: request.context,
        sealed: new Uint8Array([9]),
        header: new Uint8Array([3]),
        additionalData: new Uint8Array(),
      })
      .then(
        () => 'accepted',
        (error: Error) => error.message
      );
    gate.observe(status);
    const order: string[] = [];
    const handoff = gate.transition({
      drain: async () => {
        order.push('drain');
      },
      install: async () => {
        order.push('install');
        return status;
      },
      restart: async () => {
        order.push('restart');
      },
    });
    expect(order).toEqual([]);
    seal.resolve({ header: new Uint8Array([3]), sealed: new Uint8Array([9]) });
    open.resolve(new Uint8Array([7]));
    expect(await sealed).toBe('e2ee_epoch_superseded');
    expect(await opened).toBe('e2ee_epoch_superseded');
    expect(await handoff).toBe(true);
    expect(order).toEqual(['drain', 'install', 'restart']);
    await expect(old.seal(request)).rejects.toThrow('e2ee_epoch_superseded');
    expect(await gate.provider(native).seal(request)).toMatchObject({
      sealed: new Uint8Array([9]),
    });
    expect(gate.epoch()).toBe(1);
    expect(gate.phase()).toBe('ready');
  });

  it.each(['drain', 'install', 'restart'] as const)(
    'retains edits and retries after %s failure',
    async (step) => {
      const gate = createWorkspaceEpochTransitionLegacy({ epoch: 0 });
      const doc = new LoroDoc();
      try {
        gate.observe(status);
        doc.getText('draft').insert(0, 'retained draft');
        doc.commit();
        let failed = false;
        const failOnce = (at: string) => {
          if (at === step && !failed) {
            failed = true;
            throw new Error('temporary');
          }
        };
        const ports = {
          drain: async () => {
            failOnce('drain');
          },
          install: async () => {
            failOnce('install');
            return status;
          },
          restart: async () => {
            failOnce('restart');
          },
        };
        await expect(gate.transition(ports)).rejects.toThrow('temporary');
        expect(gate.phase()).toBe('failed');
        await expect(gate.provider(native).seal(request)).rejects.toThrow(
          'e2ee_key_update_required'
        );
        expect(await gate.transition(ports)).toBe(true);
        expect(doc.getText('draft').toString()).toBe('retained draft');
        expect(await gate.provider(native).seal(request)).toMatchObject({
          sealed: new Uint8Array([9]),
        });
      } finally {
        doc.free();
      }
    }
  );

  it('keeps another workspace sending while one handoff waits for an actual operation', async () => {
    const blocked = createWorkspaceEpochTransitionLegacy({ epoch: 0 });
    const independent = createWorkspaceEpochTransitionLegacy({ epoch: 0 });
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    blocked.observe(status);
    const handoff = blocked.transition({
      drain: async () => {
        entered.resolve();
        await release.promise;
      },
      install: async () => status,
      restart: async () => {},
    });
    await entered.promise;
    expect(await independent.provider(native).seal(request)).toMatchObject({
      sealed: new Uint8Array([9]),
    });
    expect(blocked.phase()).toBe('draining');
    release.resolve();
    expect(await handoff).toBe(true);
    expect(await blocked.provider(native).seal(request)).toMatchObject({
      sealed: new Uint8Array([9]),
    });
  });

  it('does not reopen after a superseded restart completes late', async () => {
    const gate = createWorkspaceEpochTransitionLegacy({ epoch: 0 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    gate.observe(status);
    const old = gate
      .transition({
        drain: async () => {},
        install: async () => status,
        restart: async () => {
          entered.resolve();
          await release.promise;
        },
      })
      .catch((error: Error) => error.message);
    await entered.promise;
    gate.observe({ ...status, epoch: 2 });
    release.resolve();
    expect(await old).toBe('e2ee_epoch_superseded');
    expect(gate.phase()).toBe('failed');
    expect(
      await gate.transition({
        drain: async () => {},
        install: async () => ({ ...status, epoch: 2 }),
        restart: async () => {},
      })
    ).toBe(true);
    expect(gate.epoch()).toBe(2);
  });
});

// Real SDK operations, not mocked close receipts: no network or wall-clock wait.
describe('opt-in SDK epoch retirement', () => {
  it.each(['upload', 'cursor', 'read', 'provision', 'deadline'] as const)(
    'joins actual %s work before permitting a successor',
    async (operation) => {
      if (operation === 'deadline')
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const doc = new LoroDoc();
      const url = 'https://epoch.synthetic.invalid/ds/content/room';
      let cursorSaved = false;
      const stream = new StreamsCrdt({
        streamUrl: url,
        adapter: createLoroDocAdapter(doc),
        drainOnClose: true,
        remoteCursorStore: {
          load: async () =>
            createInitialRemoteCursor({
              streamUrl: url,
              nextOffset: '00000000000000000000',
              serverLowerBoundVersion: {},
            }),
          save: async () => {
            if (operation === 'cursor' || operation === 'deadline') {
              entered.resolve();
              await release.promise;
            }
            cursorSaved = true;
          },
        },
        fetch: async (_input, init) => {
          if (operation !== 'cursor' && operation !== 'deadline') {
            entered.resolve();
            await release.promise;
          }
          const headers = new Headers(init?.headers);
          return new Response(null, {
            status: init?.method === 'PUT' ? 201 : 200,
            headers: {
              'Content-Type': 'application/octet-stream',
              'Stream-Next-Offset': '00000000000000000100',
              'Stream-Up-To-Date': 'true',
              'Producer-Epoch': headers.get('Producer-Epoch') ?? '0',
              'Producer-Seq': headers.get('Producer-Seq') ?? '0',
            },
          });
        },
      });
      doc.getText('draft').insert(0, 'saved local content');
      doc.commit();
      const work =
        operation === 'upload'
          ? stream.appendWriteOnly()
          : operation === 'provision'
            ? stream.createStream()
            : stream.catchup();
      let stopped = false;
      try {
        await entered.promise;
        if (operation === 'deadline') {
          await vi.advanceTimersByTimeAsync(120_000);
          expect((await work).ok).toBe(false);
        }
        const close = stream.close().then(() => {
          stopped = true;
        });
        // The close continuation is queued before this checkpoint if it returned
        // early. The held raw operation makes a correct close remain pending.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(stopped).toBe(false);
        release.resolve();
        const result = await work;
        await close;
        expect(result.ok).toBe(operation !== 'deadline');
        expect(stopped).toBe(true);
        if (operation === 'cursor') expect(cursorSaved).toBe(true);
        expect(doc.getText('draft').toString()).toBe('saved local content');
      } finally {
        release.resolve();
        await work;
        await stream.close();
        doc.free();
        if (operation === 'deadline') vi.useRealTimers();
      }
    }
  );
});

it('retains an SSE release failure for a successful close retry', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const liveEntered = Promise.withResolvers<void>();
  const cancelEntered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let cancelled = false;
  const url = 'https://epoch.synthetic.invalid/ds/content/sse-room';
  const doc = new LoroDoc();
  const stream = new StreamsCrdt({
    streamUrl: url,
    adapter: createLoroDocAdapter(doc),
    drainOnClose: true,
    remoteCursorStore: {
      load: async () =>
        createInitialRemoteCursor({
          streamUrl: url,
          nextOffset: '00000000000000000000',
          serverLowerBoundVersion: {},
        }),
      save: async () => {},
    },
    fetch: async (input) => {
      if (new URL(String(input)).searchParams.get('live') === 'sse') {
        liveEntered.resolve();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(': connected\n\n'));
            },
            async cancel() {
              cancelEntered.resolve();
              await release.promise;
              cancelled = true;
            },
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
              'Stream-Next-Offset': '00000000000000000100',
            },
          }
        );
      }
      return new Response(null, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Stream-Next-Offset': '00000000000000000100',
          'Stream-Up-To-Date': 'true',
        },
      });
    },
  });
  let close: Promise<string> | undefined;
  try {
    expect((await stream.join()).ok).toBe(true);
    await liveEntered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    let stopped = false;
    close = stream.close().then(
      () => {
        stopped = true;
        return 'success';
      },
      () => 'failed'
    );
    await cancelEntered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await close).toBe('failed');
    expect(cancelled).toBe(false);
    release.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancelled).toBe(true);
    await stream.close();
  } finally {
    release.resolve();
    await close;
    vi.useRealTimers();
    doc.free();
  }
});
