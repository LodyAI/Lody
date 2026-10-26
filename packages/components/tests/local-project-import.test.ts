import { describe, expect, it, vi } from 'vitest';
import {
  addProjectGroupDirectory,
  EMPTY_PROJECT_GROUP_FORM_VALUE,
} from '../src/lib/project-group-form';
import {
  getMachineFlockDocId,
  machineFlockKeys,
  type LocalProjectControlResponse,
  type LocalProjectMeta,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import {
  pickProjectGroupFolder,
  prepareLocalProject,
  registerProjectGroupDirectories,
  prepareAndWriteLocalProject,
  selectAndWriteLocalProject,
  setLocalProjectStandaloneVisibility,
} from '../src/lib/local-project-import';

const workspaceId = 'workspace-1' as WorkspaceId;
const machineId = 'machine-1' as MachineId;
const existing: LocalProjectMeta = {
  githubRepoFullName: 'acme/lody',
  id: 'project-1',
  name: 'lody',
  rootPath: '/repo/lody',
  createdAtMs: 1,
  history: {
    codex: {
      lastListedAt: 2,
      sessions: { external: { acpSessionId: 'external', title: 'Existing session' } },
    },
  },
};
function prepared(alreadyRegistered = false): LocalProjectControlResponse {
  return {
    ok: true,
    type: 'local-project/prepare-add',
    result: {
      localProjectId: 'project-1',
      name: 'lody',
      rootPath: '/repo/lody',
      alreadyRegistered,
      inspection: { isGit: true, repoFullName: 'acme/lody', submodules: [] },
    },
  };
}
function runtimeWithResponse(response = prepared(), initial?: LocalProjectMeta) {
  const rows = new Map<string, unknown>();
  const key = (doc: string, path: readonly string[]) => JSON.stringify([doc, path]);
  const rowKey = key(
    getMachineFlockDocId(workspaceId, machineId),
    machineFlockKeys.localProject('project-1')
  );
  if (initial) rows.set(rowKey, initial);
  return {
    workspaceId,
    rows,
    read: () => rows.get(rowKey) as LocalProjectMeta | undefined,
    requestLocalProjectControl: vi.fn(async (request: { inspect?: boolean; rootPath?: string }) => {
      if (response.ok && response.type === 'local-project/prepare-add' && !request.inspect) {
        const { inspection: _, ...result } = response.result;
        return { ...response, result };
      }
      return response;
    }),
    writer: {
      flockRowPutIfAbsent: vi.fn(async (doc: string, path: readonly string[], value: unknown) => {
        const k = key(doc, path);
        if (rows.has(k)) return { inserted: false, value: rows.get(k) };
        rows.set(k, value);
        return { inserted: true, value };
      }),
      flockRowUpdate: async (
        doc: string,
        path: readonly string[],
        update: (row: unknown) => unknown
      ) => {
        const k = key(doc, path);
        const next = update(rows.get(k));
        if (next === undefined) return false;
        rows.set(k, next);
        return true;
      },
    },
  };
}
const args = { machineId, rootPath: '/repo/lody', timeoutMessage: 'Timed out' };

describe('local project registration and standalone display', () => {
  it('prepares a draft and cancels native selection without writing any registration', async () => {
    const runtime = runtimeWithResponse();
    expect((await prepareLocalProject({ ...args, runtime, inspect: true })).localProjectId).toBe(
      'project-1'
    );
    expect(
      await selectAndWriteLocalProject({
        runtime,
        selectDirectory: async () => null,
        timeoutMessage: 'Timed out',
      })
    ).toBeNull();
    expect(runtime.rows.size).toBe(0);
  });
  it('registers members without a standalone entry, then promotes and reuses the same row', async () => {
    const runtime = runtimeWithResponse();
    await prepareAndWriteLocalProject({
      ...args,
      runtime,
      standaloneVisible: false,
      inspect: true,
    });
    const hidden = runtime.read()!;
    expect(hidden).toMatchObject({
      standaloneVisible: false,
      githubRepoFullName: 'acme/lody',
      rootPath: '/repo/lody',
    });
    runtime.requestLocalProjectControl.mockResolvedValue(prepared(true));
    const result = await prepareAndWriteLocalProject({ ...args, runtime });
    expect(result.status).toBe('added');
    expect(runtime.read()).toEqual({ ...hidden, standaloneVisible: true });
    expect(runtime.rows.size).toBe(1);
    expect((await prepareAndWriteLocalProject({ ...args, runtime })).status).toBe('existing');
  });
  it('keeps visible entries visible when added to a group, retaining their history', async () => {
    const runtime = runtimeWithResponse(prepared(false), existing);
    await prepareAndWriteLocalProject({ ...args, runtime, standaloneVisible: false });
    expect(runtime.read()).toEqual(existing);
  });
  it('removes only the standalone entry and can restore it without losing history or identity', async () => {
    const runtime = runtimeWithResponse(prepared(true), existing);
    await setLocalProjectStandaloneVisibility({
      runtime,
      machineId,
      localProjectId: existing.id,
      visible: false,
    });
    expect(runtime.read()).toEqual({ ...existing, standaloneVisible: false });
    await prepareAndWriteLocalProject({ ...args, runtime });
    expect(runtime.read()).toEqual({ ...existing, standaloneVisible: true });
  });
  it('rejects a retargeted path before registration', async () => {
    const runtime = runtimeWithResponse();
    await expect(
      prepareAndWriteLocalProject({ ...args, runtime, expectedLocalProjectId: 'different' })
    ).rejects.toThrow('selected folder changed');
    expect(runtime.rows.size).toBe(0);
  });
  it('does not replace a remote registration whose local row has not arrived', async () => {
    const runtime = runtimeWithResponse(prepared(true));
    await expect(prepareAndWriteLocalProject({ ...args, runtime })).rejects.toThrow('unavailable');
    expect(runtime.rows.size).toBe(0);
  });
  it('does not trust malformed existing rows or overwrite them', async () => {
    const runtime = runtimeWithResponse();
    runtime.writer.flockRowPutIfAbsent.mockResolvedValue({
      inserted: false,
      value: { id: 'project-1' },
    });
    await expect(prepareAndWriteLocalProject({ ...args, runtime })).rejects.toThrow('invalid');
    expect(runtime.rows.size).toBe(0);
  });
  it('propagates failed validation without registering a folder', async () => {
    const runtime = runtimeWithResponse();
    runtime.requestLocalProjectControl.mockRejectedValue(new Error('Directory is unavailable'));
    await expect(prepareAndWriteLocalProject({ ...args, runtime })).rejects.toThrow(
      'Directory is unavailable'
    );
    expect(runtime.rows.size).toBe(0);
  });
  it('keeps partial registrations reusable after failure and only finishes when all folders pass', async () => {
    const runtime = runtimeWithResponse();
    const inspection = { isGit: false, submodules: [] };
    const first = addProjectGroupDirectory(EMPTY_PROJECT_GROUP_FORM_VALUE, {
      machineId,
      localProjectId: 'project-1',
      name: 'one',
      rootPath: '/one',
      inspection,
    });
    const value = addProjectGroupDirectory(first, {
      machineId,
      localProjectId: 'project-2',
      name: 'two',
      rootPath: '/two',
      inspection,
    });
    let unavailable = true;
    runtime.requestLocalProjectControl.mockImplementation(async (request) => {
      if (request.rootPath === '/two' && unavailable) throw new Error('Unavailable');
      return {
        ok: true,
        type: 'local-project/prepare-add',
        result: {
          localProjectId: request.rootPath === '/one' ? 'project-1' : 'project-2',
          name: request.rootPath!,
          rootPath: request.rootPath!,
          alreadyRegistered: false,
          inspection,
        },
      };
    });
    const save = () =>
      registerProjectGroupDirectories({
        runtime,
        members: value.members,
        timeoutMessage: 'Timed out',
        changedMessage: 'Changed',
      });
    await expect(save()).rejects.toThrow('Unavailable');
    expect(runtime.rows.size).toBe(1);
    const original = runtime.read();
    unavailable = false;
    await save();
    expect(runtime.rows.size).toBe(2);
    expect(runtime.read()).toEqual(original);
    expect(runtime.read()?.standaloneVisible).toBe(false);
  });

  it('rejects a changed repository identity before publishing its registration', async () => {
    const runtime = runtimeWithResponse();
    await expect(
      prepareAndWriteLocalProject({
        ...args,
        runtime,
        inspect: true,
        expectedInspection: { isGit: false, submodules: [] },
      })
    ).rejects.toThrow('selected folder changed');
    expect(runtime.rows.size).toBe(0);
  });

  it('native selection registers a standalone entry through the renderer writer', async () => {
    const runtime = runtimeWithResponse();
    const result = await selectAndWriteLocalProject({
      runtime,
      selectDirectory: async () => ({ machineId, rootPath: '/repo/lody' }),
      timeoutMessage: 'Timed out',
    });
    expect(result).toMatchObject({ status: 'added', machineId, localProjectId: 'project-1' });
    expect(runtime.read()?.standaloneVisible).not.toBe(false);
  });
  it('keeps a picked folder a draft on a daemon that can inspect it', async () => {
    const runtime = runtimeWithResponse();
    const picked = await pickProjectGroupFolder({
      ...args,
      runtime,
      canInspect: true,
      updateRequiredMessage: 'Update Lody',
    });
    expect(picked.kind).toBe('draft');
    expect(runtime.rows.size).toBe(0);
  });
  it('registers a picked folder hidden on an older daemon that cannot inspect it', async () => {
    // An older daemon answers prepare-add without an inspection.
    const runtime = runtimeWithResponse();
    const picked = await pickProjectGroupFolder({
      ...args,
      runtime,
      canInspect: false,
      updateRequiredMessage: 'Update Lody',
    });
    expect(picked).toMatchObject({ kind: 'registered', localProjectId: 'project-1' });
    expect(runtime.read()).toMatchObject({ id: 'project-1', standaloneVisible: false });
  });
});
