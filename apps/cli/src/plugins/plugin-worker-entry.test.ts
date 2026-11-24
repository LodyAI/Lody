import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import type { HostToChildFrame } from '@lody/shared/plugins/ipc-protocol';

it('validates separately bundled attachment handlers and keeps serving after an event rejects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lody-worker-'));
  try {
    const worker = join(dir, 'worker.mjs'),
      plugin = join(dir, 'plugin.mjs');
    const options = { bundle: true, format: 'esm', platform: 'node' } as const;
    await Promise.all([
      build({
        ...options,
        entryPoints: [fileURLToPath(new URL('./plugin-worker-entry.ts', import.meta.url))],
        outfile: worker,
      }),
      build({
        ...options,
        stdin: {
          resolveDir: process.cwd(),
          contents: `import {z} from 'zod';export default {kind:'machine-plugin',register(m){m.tool({id:'large',input:z.number(),output:z.string()},(_,n)=>'é'.repeat(n));m.events.on('failure',()=>{throw Error()});m.attachmentSource({id:'files',metadataSchema:z.number()}, {search:(_,q)=>[{id:q,title:q}],resolve:(_,id)=>({title:id,markdown:id,metadata:id})})}}`,
        },
        outfile: plugin,
      }),
    ]);
    const child = fork(worker, [plugin, 'ws', 'machine'], { execArgv: [] });
    const exit = once(child, 'exit');
    const exchange = async (frame: HostToChildFrame) => {
      const reply = once(child, 'message');
      child.send(frame);
      return (await reply)[0];
    };
    try {
      expect(
        await exchange({
          type: 'init',
          pluginId: 'example',
          instanceId: 1,
          dataDir: dir,
          config: {},
          permissions: [],
        })
      ).toMatchObject({
        type: 'ready',
        handlers: expect.arrayContaining([
          expect.objectContaining({
            descriptorId: 'large',
            tool: { description: 'large', inputSchema: expect.objectContaining({ type: 'number' }) },
          }),
        ]),
      });
      expect(await exchange({ type: 'start', contextId: 'startup' })).toMatchObject({ ok: true });
      expect(
        await exchange({
          type: 'event',
          contextId: 'delivery',
          eventType: 'failure',
          eventId: 'one',
          payload: null,
        })
      ).toMatchObject({ ok: false, error: { code: 'handler_error' } });
      const base = {
        type: 'invoke',
        scope: 'session',
        target: { machineId: 'machine', workspaceId: 'ws', sessionId: 's' },
        descriptorId: 'files',
        actorUserId: 'user',
        callId: 'call',
        input: 'hello',
      } as const;
      expect(
        await exchange({ ...base, kind: 'tool', descriptorId: 'large', input: 1048576 })
      ).toMatchObject({
        ok: false,
        error: { code: 'validation_failed' },
      });
      for (const frame of [
        { ...base, kind: 'attachment-search', input: 1 },
        { ...base, kind: 'attachment-resolve' },
        { ...base, kind: 'attachment-search', target: { ...base.target, workspaceId: 'other' } },
      ] as const)
        expect(await exchange(frame)).toMatchObject({
          ok: false,
          error: { code: 'validation_failed' },
        });
      expect(await exchange({ ...base, kind: 'attachment-search' })).toMatchObject({
        ok: true,
        data: [{ id: 'hello', title: 'hello' }],
      });
    } finally {
      child.kill();
      await exit;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
