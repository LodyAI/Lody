import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Lody } from '@/lib/lody';
import type { AuthContext } from '@/lib/command-runtime';
import type { WorkspaceSummary } from '@/lib/workspace';
import type { Logger } from '@/utils/logger';
import {
  createAutomationWorkspaceLegacy,
  type AutomationWorkspaceHandle,
} from './workspace-legacy';

// Control tests use the real interpreter in-process; built artifacts verify worker ownership separately.
vi.mock('./programs/worker-client', async () => {
  const { Effect } = await import('effect');
  const { evaluateAutomationProgram, loadAutomationPrograms } = await import('./programs/quickjs');
  return {
    runAutomationProgramWorker: (
      program: string,
      context: import('@lody/shared/automations').AutomationProgramContext,
      read: (
        input: import('@lody/shared/automations').AutomationReadRequest
      ) => import('effect').Effect.Effect<
        import('@lody/shared/automations').AutomationReadResponse,
        unknown
      >,
      validateOnly: boolean
    ) =>
      loadAutomationPrograms.pipe(
        Effect.flatMap((module) =>
          Effect.tryPromise(() =>
            evaluateAutomationProgram(
              module,
              program,
              context,
              (input) => Effect.runPromise(read(input)),
              validateOnly
            )
          )
        )
      ),
  };
});

const roots: string[] = [];
const owners: AutomationWorkspaceHandle[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.dispose();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function workspaceFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lody-automation-owner-'));
  roots.push(root);
  vi.stubEnv('LODY_DATA_DIR', root);
  const noop = () => {};
  const logger: Logger = {
    debug: noop,
    trace: noop,
    info: noop,
    warn: noop,
    error: noop,
    success: noop,
    setLevel: noop,
    setDebug: noop,
    child: () => logger,
    close: async () => {},
  };
  const authority = {
    author: (sessionId: string) => (sessionId === 'session-a' ? 'user' : undefined),
    setPendingWork: noop,
    setObservations: noop,
    setAdmission: noop,
  };
  const handle = await createAutomationWorkspaceLegacy({
    lody: {
      documentManager: {
        repo: { getDocMeta: async () => ({ meta: { machineId: 'machine', userId: 'user' } }) },
      },
      resolveSessionWorkdir: async () => root,
      getAutomationSessionAuthority: () => authority,
    } as unknown as Lody,
    workspace: { id: 'workspace', name: 'synthetic', slug: 'synthetic' } as WorkspaceSummary,
    auth: {
      machineId: 'machine',
      userId: 'user',
      token: 'synthetic',
      userName: '',
      userEmail: '',
      machineName: 'synthetic',
    } as AuthContext,
    logger,
  });
  owners.push(handle);
  return handle;
}
describe('Automation control authority', () => {
  it('keeps each Session’s waits private and rejects cross-session registration', async () => {
    const host = await workspaceFixture();
    const foreign = host.ledger.registerWait(
      { program: '() => false', intervalMs: 30000 },
      'session-b',
      'user',
      1
    );
    await expect(host.command({ type: 'show', id: foreign.id }, 'session-a')).rejects.toThrow(
      'AUTOMATION_NOT_FOUND'
    );
    await expect(host.command({ type: 'cancel', id: foreign.id }, 'session-a')).rejects.toThrow(
      'AUTOMATION_NOT_FOUND'
    );
    await expect(
      host.command(
        { type: 'register', sessionId: 'session-b', program: '() => false', intervalMs: 30000 },
        'session-a'
      )
    ).rejects.toThrow('AUTOMATION_SCOPE_EXCEEDS_AUTHOR');
    expect(await host.command({ type: 'show', id: foreign.id })).toMatchObject({
      sessionId: 'session-b',
    });
    expect(await host.command({ type: 'list' }, 'session-a')).toEqual([]);
    await expect(host.command({ type: 'list' }, 'inactive-session')).rejects.toThrow(
      'AUTOMATION_ACTIVE_AUTHOR_REQUIRED'
    );
  });
  it('joins a failed command during shutdown without blocking unrelated resource cleanup', async () => {
    const host = await workspaceFixture();
    const command = host.command({ type: 'show', id: 'missing' });
    const disposal = host.dispose();
    const results = await Promise.allSettled([command, disposal]);
    expect(results[0]).toMatchObject({ status: 'rejected' });
    expect(results[1]).toEqual({ status: 'fulfilled', value: undefined });
  });
});

it('registers a condition with implicit Session identity and rejects invalid programs before persistence', async () => {
  const host = await workspaceFixture();
  await expect(
    host.command(
      { type: 'register', program: 'not valid JavaScript', intervalMs: 30000 },
      'session-a'
    )
  ).rejects.toThrow();
  expect(host.ledger.waits('user')).toEqual([]);
  const registered = await host.command(
    { type: 'register', program: 'async () => false', intervalMs: 30000 },
    'session-a'
  );
  expect(registered).toMatchObject({
    sessionId: 'session-a',
    workspaceId: 'workspace',
    state: 'waiting',
  });
  expect(
    await host.command(
      { type: 'register', program: 'async () => false', intervalMs: 30000 },
      'session-a'
    )
  ).toMatchObject({ id: host.ledger.waits('user')[0]?.id });
  expect(host.ledger.waits('user')).toHaveLength(1);
});
