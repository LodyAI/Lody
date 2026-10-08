import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Identity } from '@loro-dev/roost';
import { fromApplicationJson } from '@loro-dev/roost/lody-history';
import { createRoostHistoryReader } from '@lody/shared/session-data';
import { createRoostReadPort } from '../src/session/roost-history-port';

const testFile = dirname(fileURLToPath(import.meta.url));
const roostRoot = resolve(testFile, '../../../../roost');
const binaryPath = process.env.ROOST_NODE_OWNER ?? join(roostRoot, 'target/debug/roost-node-owner');
const clientModule = pathToFileURL(join(roostRoot, 'node/client.mjs')).href;
const hasLocalOwner = existsSync(binaryPath) && existsSync(fileURLToPath(clientModule));

describe.skipIf(!hasLocalOwner)('local Roost owner adapter', () => {
  it('projects physical successor segments into one logical Lody turn', async () => {
    const [{ RoostNodeClient }, { NodeLodyHistory }] = await Promise.all([
      import(clientModule),
      import('@loro-dev/roost/lody-history'),
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'lody-roost-local-'));
    const seed = new Uint8Array(32).fill(7);
    const identity = Identity.fromSeed(seed);
    const client = new RoostNodeClient({
      binaryPath,
      dbPath: join(directory, 'history.db'),
      seed,
      allowedOwners: [identity.owner()],
      clockMs: 1_700_000_000_000n,
      maxQueuedRequests: 16,
      maxQueuedBytes: 8 * 1024 * 1024,
    });

    try {
      await client.ready;
      const history = new NodeLodyHistory(client.stream('lody-adapter'), identity.owner());
      const accept = (businessId: string, segmentId: string, content: unknown) =>
        history.accept({
          kind: 'message' as const,
          businessId,
          segmentId,
          parents: [],
          content: fromApplicationJson(content),
        });

      await accept('user-1', '0', {
        role: 'user',
        timestamp: '2026-10-03T00:00:00.000Z',
        items: [{ type: 'text', text: 'hello' }],
      });
      await accept('assistant-1', 'primary', {
        role: 'assistant',
        timestamp: '2026-10-03T00:00:01.000Z',
        userTurnId: 'user-1',
        items: [{ type: 'text', text: 'first' }],
        finished: false,
      });
      await accept('assistant-1', 'late-output', {
        items: [{ type: 'text', text: 'late' }],
        finished: true,
      });

      const physical = await history.readProjectedMessages();
      const reader = createRoostHistoryReader(
        createRoostReadPort(history, () => ({
          initial: history.readProjectedMessages(),
          unsubscribe: () => {},
        }))
      );
      const logical = await reader.readAll();

      expect(physical).toHaveLength(3);
      expect(logical).toHaveLength(2);
      expect(logical[1]).toMatchObject({
        id: 'assistant-1',
        role: 'assistant',
        finished: true,
      });
      expect(logical[1]?.items).toEqual([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'late' },
      ]);
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});
