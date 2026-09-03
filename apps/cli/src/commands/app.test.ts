import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  LocalProjectId,
  MachineId,
} from '@lody/shared';
import { resolveLocalProjectForApp } from './app';
import { buildOpenLocalProjectDeepLink } from '@/lib/desktop-deep-link';

const MACHINE_ID = 'machine-1' as MachineId;
const ROOT_PATH = '/tmp/lody-app-test-project';
const LOCAL_PROJECT_ID = 'local-project-abc123' as LocalProjectId;
const originalPlatform = process.env.LODY_PLATFORM;

beforeEach(() => {
  process.env.LODY_PLATFORM = 'local';
});

afterEach(() => {
  if (originalPlatform === undefined) delete process.env.LODY_PLATFORM;
  else process.env.LODY_PLATFORM = originalPlatform;
});

function addOk(): Extract<LocalProjectControlResponse, { type: 'local-project/add' }> {
  return {
    ok: true,
    type: 'local-project/add',
    result: {
      localProjectId: LOCAL_PROJECT_ID,
      name: 'lody-app-test-project',
      rootPath: ROOT_PATH,
      workspaceIds: [],
    },
  };
}

function workspaceRequired(): LocalProjectControlResponse {
  return {
    ok: false,
    type: 'local-project/add',
    error: 'workspace_required',
    message: 'Multiple workspaces are active',
    data: {
      candidates: [
        { id: 'ws-1', slug: 'acme', name: 'Acme' },
        { id: 'ws-2', slug: 'globex', name: 'Globex' },
      ],
    },
  };
}

const neverPrompt = async (): Promise<string | null> => {
  throw new Error('promptWorkspace must not be called');
};

describe('resolveLocalProjectForApp', () => {
  it('registers the directory and reports the daemon-assigned project id', async () => {
    const send = vi.fn(async () => addOk());

    const target = await resolveLocalProjectForApp({
      machineId: MACHINE_ID,
      rootPath: ROOT_PATH,
      workspaceSelector: undefined,
      canPrompt: false,
      send,
      promptWorkspace: neverPrompt,
    });

    expect(send).toHaveBeenCalledWith({
      type: 'local-project/add',
      machineId: MACHINE_ID,
      rootPath: ROOT_PATH,
    });
    expect(target).toEqual({
      localProjectId: LOCAL_PROJECT_ID,
      name: 'lody-app-test-project',
      workspaceSlug: null,
      registered: true,
    });
  });

  it('forwards an explicit workspace selector', async () => {
    const send = vi.fn(async () => addOk());

    await resolveLocalProjectForApp({
      machineId: MACHINE_ID,
      rootPath: ROOT_PATH,
      workspaceSelector: 'acme',
      canPrompt: false,
      send,
      promptWorkspace: neverPrompt,
    });

    expect(send).toHaveBeenCalledWith({
      type: 'local-project/add',
      machineId: MACHINE_ID,
      rootPath: ROOT_PATH,
      workspace: 'acme',
    });
  });

  it('retries with the chosen workspace and keeps its slug for the deep link', async () => {
    const send = vi
      .fn<(message: LocalProjectControlRequest) => Promise<LocalProjectControlResponse>>()
      .mockResolvedValueOnce(workspaceRequired())
      .mockResolvedValueOnce(addOk());

    const target = await resolveLocalProjectForApp({
      machineId: MACHINE_ID,
      rootPath: ROOT_PATH,
      workspaceSelector: undefined,
      canPrompt: true,
      send,
      promptWorkspace: async () => 'ws-2',
    });

    expect(send).toHaveBeenLastCalledWith({
      type: 'local-project/add',
      machineId: MACHINE_ID,
      rootPath: ROOT_PATH,
      workspace: 'ws-2',
    });
    expect(target.workspaceSlug).toBe('globex');
    expect(target.registered).toBe(true);
  });

  it('fails with the candidate list when multiple workspaces are active and prompting is impossible', async () => {
    const send = vi.fn(async () => workspaceRequired());

    await expect(
      resolveLocalProjectForApp({
        machineId: MACHINE_ID,
        rootPath: ROOT_PATH,
        workspaceSelector: undefined,
        canPrompt: false,
        send,
        promptWorkspace: neverPrompt,
      })
    ).rejects.toThrow('--workspace');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('still resolves the deterministic project id when the daemon is down', async () => {
    const send = vi.fn(async (): Promise<LocalProjectControlResponse> => ({
      ok: false,
      type: 'local-project/add',
      error: 'daemon_unavailable',
      message: 'Local CLI daemon is not running.',
    }));

    const target = await resolveLocalProjectForApp({
      machineId: MACHINE_ID,
      rootPath: ROOT_PATH,
      workspaceSelector: undefined,
      canPrompt: false,
      send,
      promptWorkspace: neverPrompt,
    });

    expect(target.registered).toBe(false);
    expect(target.localProjectId).toMatch(/^local-project-[0-9a-f]{24}$/);
    expect(target.name).toBe('lody-app-test-project');
  });

  it('propagates other control failures', async () => {
    const send = vi.fn(async (): Promise<LocalProjectControlResponse> => ({
      ok: false,
      type: 'local-project/add',
      error: 'path_invalid',
      message: 'Selected path is not a directory',
    }));

    await expect(
      resolveLocalProjectForApp({
        machineId: MACHINE_ID,
        rootPath: ROOT_PATH,
        workspaceSelector: undefined,
        canPrompt: false,
        send,
        promptWorkspace: neverPrompt,
      })
    ).rejects.toThrow('Selected path is not a directory');
  });
});

describe('buildOpenLocalProjectDeepLink', () => {
  it('pins the URL shape the desktop resolver parses', () => {
    expect(
      buildOpenLocalProjectDeepLink({
        machineId: MACHINE_ID,
        localProjectId: LOCAL_PROJECT_ID,
        workspaceSlug: 'acme',
      })
    ).toBe(
      `lody-oss://chat/new?machine=${MACHINE_ID}&project=${LOCAL_PROJECT_ID}&workspaceSlug=acme`
    );
  });

  it('omits an unknown workspace slug so the app keeps its current workspace', () => {
    expect(
      buildOpenLocalProjectDeepLink({
        machineId: MACHINE_ID,
        localProjectId: LOCAL_PROJECT_ID,
        workspaceSlug: null,
      })
    ).toBe(`lody-oss://chat/new?machine=${MACHINE_ID}&project=${LOCAL_PROJECT_ID}`);
  });

  it('uses the official desktop protocol in cloud mode', () => {
    process.env.LODY_PLATFORM = 'cloud';
    expect(
      buildOpenLocalProjectDeepLink({
        machineId: MACHINE_ID,
        localProjectId: LOCAL_PROJECT_ID,
        workspaceSlug: 'acme',
      })
    ).toBe(`lody://chat/new?machine=${MACHINE_ID}&project=${LOCAL_PROJECT_ID}&workspaceSlug=acme`);
  });
});
