import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Lody } from '@/lib/lody';
import type { AuthContext } from '@/lib/command-runtime';
import type { WorkspaceSummary } from '@/lib/workspace';
import type { Logger } from '@/utils/logger';
import { SessionDocument } from '@/lib/loro/doc';
import { composeTestSessionDoc } from '../../tests/session-doc-fixture';
import { createSessionBackend } from '@/session/session-backend';
import type { SessionId } from '@lody/shared';
import type { AutomationSessionAdmission } from '@/session/session-automation-authority';
import type { SessionTurnInputConfig } from '@lody/shared';
import {
  createAutomationWorkspaceLegacy,
  type AutomationWorkspaceHandle,
} from './workspace-legacy';

const roots: string[] = [];
const owners: AutomationWorkspaceHandle[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.dispose();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function workspaceFixture(
  meta: {
    id: string;
    machineId: string;
    userId: string;
    collaborationStopped: boolean;
    cliType?: string;
    agentType?: string;
  } = { id: 'session-a', machineId: 'machine', userId: 'user', collaborationStopped: false },
  existingRoot?: string
) {
  const root = existingRoot ?? mkdtempSync(path.join(os.tmpdir(), 'lody-automation-owner-'));
  if (!existingRoot) roots.push(root);
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
  let admit: ((args: AutomationSessionAdmission) => Promise<boolean>) | undefined;
  const authority = {
    author: (sessionId: string) => (sessionId === 'session-a' ? 'user' : undefined),
    setPendingWork: noop,
    setObservations: noop,
    setAdmission: (check: typeof admit) => {
      admit = check;
    },
    acceptInput: (args: {
      sessionId: SessionId;
      turnId: string;
      userId: string;
      config: SessionTurnInputConfig;
    }) => {
      const origin = args.config._lodyAutomation;
      return origin && admit ? admit({ ...args, origin }) : Promise.resolve(false);
    },
    inputDisposition: () => 'unsubmitted',
  };
  const repo = { getDocMeta: async () => ({ meta }), flush: async () => {} };
  const doc = new SessionDocument(repo as never, meta.id as SessionId, async () => {}, logger);
  composeTestSessionDoc(doc);
  const handle = await createAutomationWorkspaceLegacy({
    hasUncertainLegacyQuota: () => false,
    lody: {
      documentManager: { repo, getOrCreateSessionDoc: async () => doc },
      hasAutomationSessionWork: () => false,
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
  return Object.assign(handle, { testRoot: root, testDocument: doc });
}
describe('Automation control authority', () => {
  it('delivers the persisted match after its event leaves the window and the owner restarts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const meta = {
      id: 'session-a',
      machineId: 'machine',
      userId: 'user',
      collaborationStopped: true,
      cliType: 'builtin',
      agentType: 'synthetic',
    };
    const host = await workspaceFixture(meta);
    const event = {
      id: 'build',
      source: 'test/build',
      type: 'build.result',
      version: 1,
      subject: 'build',
      observedAt: Date.now(),
      scope: { workspaceId: 'workspace', sessionId: 'session-a' },
      data: { status: 'ready', failedTests: 0, build: 'original' },
      provenance: 'callback' as const,
      completeness: 'observed' as const,
      depth: 0,
    };
    host.ledger.publish(event);
    const wait = host.ledger.registerWait(
      {
        program: `async ({ctx}) => {
      const {value} = await ctx.read('events', {limit: 50});
      const build = value.find(event => event.type === 'build.result' && event.data.status === 'ready');
      return build ? {resumeText: 'Original build completed', payload: build.data} : false;
    }`,
        intervalMs: 1000,
      },
      'session-a',
      'user',
      Date.now()
    );
    await host.wake();
    await vi.advanceTimersByTimeAsync(1000);
    const matched = host.ledger.wait(wait.id);
    expect(matched).toMatchObject({
      state: 'matched',
      result: { resumeText: 'Original build completed', payload: event.data },
    });
    const invocationId = matched?.invocationId;
    if (!invocationId) throw new Error('missing continuation');
    expect(host.ledger.receipt(invocationId)).toMatchObject({
      state: 'blocked',
      reason: 'target_stopped',
    });
    for (let i = 0; i < 51; i++)
      host.ledger.publish({
        ...event,
        id: `other-${i}`,
        type: 'build.other',
        subject: `other-${i}`,
      });
    expect(host.ledger.sessionEvents('session-a', 0, 50).some((item) => item.id === event.id)).toBe(
      false
    );
    await host.dispose();
    owners.splice(owners.indexOf(host), 1);
    meta.collaborationStopped = false;
    const restarted = await workspaceFixture(meta, host.testRoot);
    await restarted.wake();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(restarted.ledger.wait(wait.id)).toMatchObject({
      state: 'matched',
      invocationId,
      result: { payload: event.data },
    });
    expect(restarted.ledger.receipt(invocationId)).toMatchObject({ state: 'queued', attempts: 1 });
    const queue = await (await createSessionBackend(restarted.testDocument)).getMessageQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ operationId: invocationId });
    expect(queue[0]?.task).toContain('Original build completed');
    expect(queue[0]?.task).toContain('"build":"original"');
  });
  it('keeps Stop out of condition errors and retains one blocked continuation until cancel', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const meta = {
      id: 'session-a',
      machineId: 'machine',
      userId: 'user',
      collaborationStopped: false,
    };
    const host = await workspaceFixture(meta);
    const wait = host.ledger.registerWait(
      {
        program: `async ({ctx}) => {
        const {value} = await ctx.read('session');
        return value.stopped ? false : {resumeText: 'Continue'};
      }`,
        intervalMs: 1000,
      },
      'session-a',
      'user',
      Date.now()
    );
    meta.collaborationStopped = true;
    await host.wake();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.ledger.wait(wait.id)).toMatchObject({ state: 'waiting', consecutiveErrors: 0 });
    expect(host.ledger.wait(wait.id)?.checks).toBeGreaterThanOrEqual(5);

    const ready = host.ledger.registerWait(
      {
        program: `async ({ctx}) => {
        await ctx.read('session');
        return {resumeText: 'Ready while stopped'};
      }`,
        intervalMs: 1000,
      },
      'session-a',
      'user',
      Date.now()
    );
    await host.wake();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await host.command({ type: 'show', id: ready.id })).toMatchObject({
      state: 'matched',
      consecutiveErrors: 0,
      continuation: { state: 'blocked', reason: 'target_stopped' },
    });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(host.ledger.activities()).toHaveLength(1);
    expect(host.ledger.activities()[0]).toMatchObject({ state: 'blocked', attempts: 0 });
    expect(meta.collaborationStopped).toBe(true);
    await host.command({ type: 'cancel', id: ready.id });
    meta.collaborationStopped = false;
    await host.wake();
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.ledger.wait(ready.id)?.state).toBe('cancelled');
    expect(host.ledger.wait(wait.id)?.consecutiveErrors).toBe(0);
  });
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
