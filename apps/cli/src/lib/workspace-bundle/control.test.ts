import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LOCAL_WORKSPACE_BUNDLE_PATH, type MachineId } from '@lody/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalControlHandler } from '@/lib/local-control-handler';
import type { Logger } from '@/utils/logger';
import { handleWorkspaceBundleControl } from './control';
import { openTestRepo, writeDoc } from './test-support';

const machineId = 'machine-1' as MachineId;
const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function handler(
  dispatch: ConstructorParameters<typeof LocalControlHandler>[0]['dispatchWorkspaceBundle']
) {
  return new LocalControlHandler({
    machineId,
    logger: createSilentLogger(),
    dispatchSession: async () => [],
    dispatchProject: async () => {
      throw new Error('unexpected');
    },
    ...(dispatch ? { dispatchWorkspaceBundle: dispatch } : {}),
  });
}

describe('workspace bundle local control', () => {
  it('routes valid requests for this machine and refuses others', async () => {
    const seen: unknown[] = [];
    const control = handler(async (request) => {
      seen.push(request);
      return { ok: true, result: { rooms: 1 } };
    });
    const body = { operation: 'export', machineId, workspaceId: 'lw_1', out: '/tmp/x.lodybundle' };
    await expect(
      control.handle({
        path: LOCAL_WORKSPACE_BUNDLE_PATH,
        rawBody: JSON.stringify(body),
        requestId: 1,
      })
    ).resolves.toEqual({ status: 200, payload: { ok: true, result: { rooms: 1 } } });
    expect(seen).toEqual([body]);
    const other = await control.handle({
      path: LOCAL_WORKSPACE_BUNDLE_PATH,
      rawBody: JSON.stringify({ ...body, machineId: 'machine-2' }),
      requestId: 2,
    });
    expect(other.status).toBe(403);
    const relative = await control.handle({
      path: LOCAL_WORKSPACE_BUNDLE_PATH,
      rawBody: JSON.stringify({ ...body, out: 'x.lodybundle' }),
      requestId: 3,
    });
    expect(relative.status).toBe(400);
    const unsupported = await handler(undefined).handle({
      path: LOCAL_WORKSPACE_BUNDLE_PATH,
      rawBody: JSON.stringify(body),
      requestId: 4,
    });
    expect(unsupported.status).toBe(501);
  });

  it('runs export and import against the daemon repo and reports failures as errors', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-bundle-ctl-'));
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const test = await openTestRepo(path.join(dir));
    cleanup.push(() => test.close());
    await writeDoc(test.repo, 'session-s1', { title: 'One' }, (doc) =>
      doc.getText('t').insert(0, 'hi')
    );
    const deps = {
      workspace: { id: 'lw_1', repo: test.repo },
      role: 'owner',
      actor: { userId: 'local:u', machineId, lodyVersion: 't' },
      journalDir: path.join(dir, 'journals'),
    };
    const out = path.join(dir, 'w.lodybundle');
    const exported = await handleWorkspaceBundleControl(
      { operation: 'export', machineId, workspaceId: 'lw_1', out },
      deps
    );
    expect(exported).toMatchObject({ ok: true, result: { rooms: 2 } });
    const again = await handleWorkspaceBundleControl(
      { operation: 'export', machineId, workspaceId: 'lw_1', out },
      deps
    );
    expect(again).toMatchObject({ ok: false, error: expect.stringContaining('exists') });
    const dry = await handleWorkspaceBundleControl(
      { operation: 'import', machineId, workspaceId: 'lw_1', file: out, dryRun: true },
      deps
    );
    expect(dry).toMatchObject({ ok: true, result: { plan: { targetWorkspaceId: 'lw_1' } } });
  });
});
