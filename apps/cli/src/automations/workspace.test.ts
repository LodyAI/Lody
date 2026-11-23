import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { getSessionRoomId, type SessionId } from '@lody/shared';
import {
  remoteAutomationSecretEnvelopeSchema,
  type AutomationInvocation,
  type AutomationRuleDraft,
  type RemoteAutomationIntent,
  type RemoteAutomationOperation,
} from '@lody/shared/automations';
import type { AutomationSessionAdmission } from '@/session/session-automation-authority';
import type { SessionTurnInputConfig } from '@lody/shared';
import { providerBindingFingerprint } from '@/session/automation-observations';
import { internalPolicy } from './policies/session';
import { createRpcSecretRecipient, encryptRpcSecret } from '@lody/loro-streams-rpc';
import {
  createAutomationWorkspaceLegacy,
  type AutomationWorkspaceHandle,
} from './workspace-legacy';

const roots: string[] = [];
const owners: AutomationWorkspaceHandle[] = [];
function required<A>(value: A | undefined): A {
  if (value === undefined) throw new Error('Required value missing');
  return value;
}
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
    isArchived?: boolean;
    cliType?: string;
    agentType?: string;
    latestUserMsgId?: string;
    acpSessionId?: string;
  } = { id: 'session-a', machineId: 'machine', userId: 'user', collaborationStopped: false },
  existingRoot?: string,
  verifyRemoteControl?: (input: {
    intent: RemoteAutomationIntent;
    requestToken: string;
  }) => Promise<{ requesterUserId: string; expiresAt: number }>,
  quota?: {
    config: Parameters<typeof providerBindingFingerprint>[0];
    refresh: () => Promise<unknown>;
  }
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
  const editors = new Set(['user']);
  const authors = new Map([['session-a', 'user']]);
  const authority = {
    author: (sessionId: string) => authors.get(sessionId),
    canEdit: async (_sessionId: string, userId: string) =>
      editors.has(userId) ? ('yes' as const) : ('no' as const),
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
    cancelInput: async (_sessionId: SessionId, turnId: string) => {
      const backend = await createSessionBackend(doc);
      for (const item of await backend.getMessageQueue())
        if (item.userTurnId === turnId) await backend.removeMessageQueueItem(item.$cid);
      return true;
    },
    refreshCapacity: () => quota?.refresh(),
  };
  const repo = {
    getDocMeta: async (room: string) =>
      room === getSessionRoomId(meta.id as SessionId) ? { meta } : undefined,
    upsertDocMeta: async (room: string, patch: Record<string, unknown>) => {
      if (room !== getSessionRoomId(meta.id as SessionId)) throw new Error('Unknown session');
      Object.assign(meta, patch);
    },
    flush: async () => {},
  };
  const doc = new SessionDocument(repo as never, meta.id as SessionId, async () => {}, logger);
  composeTestSessionDoc(doc);
  const handle = await createAutomationWorkspaceLegacy({
    verifyRemoteControl,
    lody: {
      documentManager: {
        repo,
        isEncryptedWorkspace: () => false,
        signMachineInput: async () => undefined,
        getOrCreateSessionDoc: async () => doc,
        getAgentConfigForMachineLaunch: async () => quota?.config,
      },
      hasAutomationSessionWork: () => false,
      resolveAutomationWorkdir: async () => root,
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
  return Object.assign(handle, {
    testRoot: root,
    testRepo: repo,
    testDocument: doc,
    testEditors: editors,
    testAuthors: authors,
    testAdmission: (args: AutomationSessionAdmission) => admit?.(args),
  });
}
describe('Automation control authority', () => {
  it('executes a registered condition in the Session workspace', async () => {
    const host = await workspaceFixture({
      id: 'session-a',
      machineId: 'machine',
      userId: 'user',
      collaborationStopped: true,
    });
    const wait = host.ledger.registerWait(
      {
        program: `async ({ctx}) => {
        const result = await ctx.exec({command: ${JSON.stringify(process.execPath)}, args: ['-e', 'process.stdout.write(process.cwd()); process.exitCode = 7']});
        return result.exitCode === 7 ? {resumeText: 'Command completed', payload: result.stdout} : false;
      }`,
        intervalMs: 30000,
      },
      'session-a',
      'user',
      Date.now()
    );
    await host.wake();
    await vi.waitFor(() => expect(host.ledger.wait(wait.id)?.state).toBe('matched'));
    expect(host.ledger.wait(wait.id)?.result).toEqual({
      resumeText: 'Command completed',
      payload: await import('node:fs/promises').then((fs) => fs.realpath(host.testRoot)),
    });
  });
  it('queries capacity at the reset even when the exhausted snapshot is still fresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const refreshed = Promise.withResolvers<void>();
    const config = { id: 'binding', cliType: 'builtin', agentType: 'claude', env: {} } as const;
    const meta = {
      id: 'session-a',
      machineId: 'machine',
      userId: 'user',
      collaborationStopped: false,
      latestUserMsgId: 'input',
      acpSessionId: 'native',
    };
    const host = await workspaceFixture(meta, undefined, undefined, {
      config,
      refresh: async () => {
        refreshed.resolve();
      },
    });
    const fingerprint = providerBindingFingerprint(config);
    host.ledger.recordCapacity(
      {
        bindingId: 'binding',
        fingerprint,
        observedAt: 90_000,
        validUntil: 200_000,
        source: 'query',
        authentication: 'valid',
        billing: 'valid',
        windows: [{ id: 'quota', usedPercent: 100, resetsAt: 100_000 }],
      },
      90_000
    );
    await host.command({
      type: 'configure',
      sessionId: 'session-a',
      settings: { recoverCapacity: true },
    });
    const work = {
      id: 'due-work',
      ownerUserId: 'user',
      updatedAt: 90_000,
      sessionId: 'session-a',
      turnId: 'input',
      nativeSessionId: 'native',
      bindingId: 'binding',
      fingerprint,
      inputRef: 'input',
      confirmedBoundary: 'assistant',
      unresolvedEffects: false,
      release: 'released' as const,
      state: 'blocked_on_capacity' as const,
      notBefore: 100_000,
      attempts: 0,
    };
    host.ledger.recordWork(work, {
      id: work.id,
      source: 'session/session-a',
      type: 'provider.quota.exhausted',
      version: 1,
      subject: work.id,
      observedAt: 90_000,
      scope: { workspaceId: 'workspace', sessionId: 'session-a' },
      data: { workId: work.id, bindingId: work.bindingId, retryAt: 100_000 },
      provenance: 'callback',
      completeness: 'observed',
      depth: 0,
    });
    const delivery = host.ledger.deliveries().find((item) => item.event.id === work.id)!;
    const receipt = host.ledger.accept(delivery, internalPolicy(delivery)[0]!, 90_000);
    host.ledger.finishDelivery(delivery, undefined, 90_000);
    await host.wake();
    await vi.advanceTimersByTimeAsync(1);
    await refreshed.promise;
    expect(host.ledger.receipt(receipt.id)?.state).not.toBe('settled');
  });
  it('clears a finished Auto delivery status when it is dismissed after the merge', async () => {
    const meta = {
      id: 'session-a',
      machineId: 'machine',
      userId: 'user',
      collaborationStopped: false,
      autoDelivery: { state: 'merged', updatedAt: 1 } as Record<string, unknown> | null,
    };
    const host = await workspaceFixture(meta);
    await host.command({
      type: 'configure',
      sessionId: 'session-a',
      settings: { autoDeliver: false },
    });
    expect(meta.autoDelivery).toBeNull();
  });
  it('does not republish an Auto delivery status after it is turned off during a pass', async () => {
    vi.useFakeTimers();
    const meta = {
      id: 'session-a',
      machineId: 'machine',
      userId: 'user',
      collaborationStopped: false,
      pullRequests: [{ url: 'https://github.com/owner/project/pull/42', status: 'open' }],
      autoDelivery: undefined as Record<string, unknown> | null | undefined,
    };
    const host = await workspaceFixture(meta);
    await host.command({
      type: 'configure',
      sessionId: 'session-a',
      settings: { autoDeliver: { fixCi: true, resolveConflicts: true, merge: false } },
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(meta.autoDelivery).toMatchObject({ state: 'ci' });
    const read = host.testRepo.getDocMeta;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    host.testRepo.getDocMeta = async (room: string) => {
      host.testRepo.getDocMeta = read;
      entered.resolve();
      await release.promise;
      return read(room);
    };
    await host.wake();
    await vi.advanceTimersByTimeAsync(1);
    await entered.promise;
    const turnedOff = host.command({
      type: 'configure',
      sessionId: 'session-a',
      settings: { autoDeliver: false },
    });
    await vi.advanceTimersByTimeAsync(1);
    release.resolve();
    await vi.advanceTimersByTimeAsync(1);
    await turnedOff;
    await host.wake();
    await vi.advanceTimersByTimeAsync(1);
    expect(meta.autoDelivery).toBeNull();
  });
  it('withdraws an unsent Auto delivery request when delivery is turned off', async () => {
    vi.useFakeTimers();
    const meta = {
      id: 'session-a',
      machineId: 'machine',
      userId: 'user',
      collaborationStopped: false,
    };
    const host = await workspaceFixture(meta);
    await host.command({
      type: 'configure',
      sessionId: 'session-a',
      settings: { autoDeliver: { fixCi: true, resolveConflicts: true, merge: false } },
    });
    await vi.advanceTimersByTimeAsync(1);
    const request = required(
      host.ledger.activities().find((receipt) => receipt.event.source === 'lody/auto-delivery')
    );
    expect(['accepted', 'blocked']).toContain(host.ledger.receipt(request.id)?.state);
    expect(host.ledger.hasSessionWork('session-a')).toBe(true);
    await host.command({
      type: 'configure',
      sessionId: 'session-a',
      settings: { autoDeliver: false },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.ledger.receipt(request.id)?.state).toBe('cancelled');
    expect(host.ledger.hasSessionWork('session-a')).toBe(false);
  });
  it('enables recovery for the current confirmed failure without replaying a later input', async () => {
    const meta = {
      id: 'session-a',
      machineId: 'machine',
      userId: 'user',
      collaborationStopped: false,
      latestUserMsgId: 'input',
    };
    const host = await workspaceFixture(meta);
    const work = {
      id: 'work',
      ownerUserId: 'user',
      updatedAt: 100,
      sessionId: 'session-a',
      turnId: 'input',
      nativeSessionId: 'native',
      bindingId: 'binding',
      fingerprint: 'fingerprint',
      inputRef: 'input',
      confirmedBoundary: 'assistant',
      unresolvedEffects: false,
      release: 'released' as const,
      state: 'blocked_on_capacity' as const,
      attempts: 0,
    };
    host.ledger.recordWork(work, {
      id: 'work',
      source: 'session/session-a',
      type: 'provider.quota.exhausted',
      version: 1,
      subject: 'work',
      observedAt: 100,
      scope: { workspaceId: 'workspace', sessionId: 'session-a' },
      data: { workId: 'work', bindingId: 'binding' },
      provenance: 'callback',
      completeness: 'observed',
      depth: 0,
    });
    await host.command({
      type: 'configure',
      sessionId: 'session-a',
      settings: { recoverCapacity: true },
    });
    const activated = host.ledger
      .sessionEvents('session-a', 0, 100)
      .filter((event) => event.type === 'provider.quota.exhausted');
    expect(activated).toHaveLength(2);
    await host.command({
      type: 'configure',
      sessionId: 'session-a',
      settings: { recoverCapacity: true },
    });
    expect(
      host.ledger
        .sessionEvents('session-a', 0, 100)
        .filter((event) => event.type === 'provider.quota.exhausted')
    ).toHaveLength(2);
  });
  it('returns every remote wait in encrypted pages even with long reasons', async () => {
    const host = await workspaceFixture(undefined, undefined, async () => ({
      requesterUserId: 'user',
      expiresAt: Date.now() + 60_000,
    }));
    if (!host.remoteControlNonce) throw new Error('missing remote nonce');
    const ids = new Set<string>();
    for (let index = 0; index < 15; index++) {
      ids.add(
        host.ledger.registerWait(
          { program: `() => ${index} === -1`, intervalMs: 1000, reason: '\u0000'.repeat(2000) },
          'session-a',
          'user',
          index
        ).id
      );
    }
    const recipient = await createRpcSecretRecipient();
    const received: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const result = await host.remoteControl({
        sessionId: 'session-a',
        requesterUserId: 'user',
        responseKey: recipient.publicKey,
        operation: { type: 'list', ...(after ? { after } : {}) },
        proof: {
          runtimeNonce: host.remoteControlNonce,
          requestId: crypto.randomUUID(),
          requestToken: 'valid',
        },
      });
      if (result.type !== 'list') throw new Error('unexpected result');
      const ciphertext = await encryptRpcSecret(
        recipient.publicKey,
        JSON.stringify(result),
        'test',
        remoteAutomationSecretEnvelopeSchema
      );
      expect(
        JSON.parse(
          await recipient.decrypt(ciphertext, 'test', remoteAutomationSecretEnvelopeSchema)
        )
      ).toEqual(result);
      received.push(...result.waits.map((wait) => wait.id));
      after = result.next;
      pages++;
    } while (after);
    expect(pages).toBeGreaterThan(1);
    expect(new Set(received)).toEqual(ids);
    expect(received).toHaveLength(ids.size);
  });
  it('authorizes an exact remote Session operation and rejects replay or foreign cancellation', async () => {
    const claims: RemoteAutomationIntent[] = [];
    const host = await workspaceFixture(undefined, undefined, async ({ intent, requestToken }) => {
      if (requestToken !== 'valid') throw new Error('invalid proof');
      claims.push(intent);
      return { requesterUserId: 'user', expiresAt: Date.now() + 60_000 };
    });
    if (!host.remoteControlNonce) throw new Error('missing remote nonce');
    const proof = {
      runtimeNonce: host.remoteControlNonce,
      requestId: '91c6cc18-1685-4d18-965e-3e8f4769d068',
      requestToken: 'valid',
    };
    const input = {
      sessionId: 'session-a',
      requesterUserId: 'user',
      responseKey: (await createRpcSecretRecipient()).publicKey,
      operation: { type: 'configure' as const, settings: { recoverCapacity: true } },
      proof,
    };
    expect(await host.remoteControl(input)).toMatchObject({
      type: 'settings',
      settings: { recoverCapacity: true },
    });
    expect(claims[0]).toMatchObject({
      workspaceId: 'workspace',
      machineId: 'machine',
      sessionId: 'session-a',
      requesterUserId: 'user',
      operation: input.operation,
    });
    await expect(host.remoteControl(input)).rejects.toThrow('AUTOMATION_REQUEST_USED');
    const foreign = host.ledger.registerWait(
      { program: '() => false', intervalMs: 1000 },
      'other-session',
      'user',
      1
    );
    await expect(
      host.remoteControl({
        ...input,
        operation: { type: 'cancel', id: foreign.id },
        proof: { ...proof, requestId: 'ebc3e567-5b01-4fe8-a88c-7a669dbfcd13' },
      })
    ).rejects.toThrow('AUTOMATION_NOT_FOUND');
    expect(host.ledger.wait(foreign.id)?.state).toBe('waiting');
    await expect(
      host.remoteControl({
        ...input,
        requesterUserId: 'other',
        proof: { ...proof, requestId: 'f81d700c-ac52-4f3e-87fd-f88ebf59f1d8' },
      })
    ).rejects.toThrow('AUTOMATION_PERMISSION_DENIED');
  });
  it('fails closed without a verifier', async () => {
    const unavailable = await workspaceFixture();
    expect(unavailable.remoteControlNonce).toBeUndefined();
    await expect(
      unavailable.remoteControl({
        sessionId: 'session-a',
        requesterUserId: 'user',
        responseKey: (await createRpcSecretRecipient()).publicKey,
        operation: { type: 'list' },
        proof: {
          runtimeNonce: 'f6a77337-2a71-410f-b5c1-0f3fe503481b',
          requestId: 'f81d700c-ac52-4f3e-87fd-f88ebf59f1d8',
          requestToken: 'valid',
        },
      })
    ).rejects.toThrow('AUTOMATION_REMOTE_AUTH_UNAVAILABLE');
  });
  it('lets a teammate who can edit the Session manage its automations remotely as the author', async () => {
    const host = await workspaceFixture(
      { id: 'session-a', machineId: 'machine', userId: 'teammate', collaborationStopped: false },
      undefined,
      async () => ({ requesterUserId: 'teammate', expiresAt: Date.now() + 60_000 })
    );
    host.testEditors.add('teammate');
    const nonce = host.remoteControlNonce;
    if (!nonce) throw new Error('missing remote nonce');
    const responseKey = (await createRpcSecretRecipient()).publicKey;
    const remote = (operation: RemoteAutomationOperation) =>
      host.remoteControl({
        sessionId: 'session-a',
        requesterUserId: 'teammate',
        responseKey,
        operation,
        proof: { runtimeNonce: nonce, requestId: crypto.randomUUID(), requestToken: 'valid' },
      });
    const ownerWait = host.ledger.registerWait(
      { program: '() => false', intervalMs: 30_000 },
      'session-a',
      'user',
      1
    );
    expect(await remote({ type: 'configure', settings: { recoverCapacity: true } })).toMatchObject({
      type: 'settings',
      settings: { recoverCapacity: true },
    });
    expect(host.ledger.rules().find((rule) => rule.name === 'recover-capacity')).toMatchObject({
      ownerUserId: 'teammate',
    });
    expect(await remote({ type: 'list' })).toMatchObject({
      waits: [expect.objectContaining({ id: ownerWait.id })],
    });
    expect(await remote({ type: 'cancel', id: ownerWait.id })).toEqual({ type: 'cancel' });
    expect(host.ledger.wait(ownerWait.id)?.state).toBe('cancelled');
  });
  it('keeps a workspace member without edit access out of the Session automations', async () => {
    const host = await workspaceFixture(undefined, undefined, async () => ({
      requesterUserId: 'reader',
      expiresAt: Date.now() + 60_000,
    }));
    const nonce = host.remoteControlNonce;
    if (!nonce) throw new Error('missing remote nonce');
    const responseKey = (await createRpcSecretRecipient()).publicKey;
    const wait = host.ledger.registerWait(
      { program: '() => false', intervalMs: 30_000 },
      'session-a',
      'user',
      1
    );
    for (const operation of [
      { type: 'list' },
      { type: 'configure', settings: { recoverCapacity: true } },
      { type: 'cancel', id: wait.id },
    ] satisfies RemoteAutomationOperation[]) {
      await expect(
        host.remoteControl({
          sessionId: 'session-a',
          requesterUserId: 'reader',
          responseKey,
          operation,
          proof: { runtimeNonce: nonce, requestId: crypto.randomUUID(), requestToken: 'valid' },
        })
      ).rejects.toThrow('AUTOMATION_PERMISSION_DENIED');
    }
    expect(host.ledger.rules().filter((rule) => rule.name === 'recover-capacity')).toEqual([]);
    expect(host.ledger.wait(wait.id)?.state).toBe('waiting');
  });
  it('rechecks the requester’s edit access after verification and admits a proof at most once', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const meta = {
      id: 'session-a',
      machineId: 'machine',
      userId: 'user',
      collaborationStopped: false,
    };
    const host = await workspaceFixture(meta, undefined, async () => {
      entered.resolve();
      await release.promise;
      return { requesterUserId: 'teammate', expiresAt: Date.now() + 60_000 };
    });
    host.testEditors.add('teammate');
    if (!host.remoteControlNonce) throw new Error('missing remote nonce');
    const input = {
      sessionId: 'session-a',
      requesterUserId: 'teammate',
      responseKey: (await createRpcSecretRecipient()).publicKey,
      operation: { type: 'configure' as const, settings: { recoverCapacity: true } },
      proof: {
        runtimeNonce: host.remoteControlNonce,
        requestId: 'c31fd4a3-b930-4920-865e-f6eebbd5ee8a',
        requestToken: 'valid',
      },
    };
    const first = host.remoteControl(input);
    const duplicate = host.remoteControl(input);
    await entered.promise;
    host.testEditors.delete('teammate');
    release.resolve();
    const results = await Promise.allSettled([first, duplicate]);
    expect(results.every((item) => item.status === 'rejected')).toBe(true);
    expect(host.ledger.rules().filter((rule) => rule.name === 'recover-capacity')).toEqual([]);
  });
  it('allows only one simultaneous use of a verified remote proof', async () => {
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let count = 0;
    const host = await workspaceFixture(undefined, undefined, async () => {
      count += 1;
      if (count === 2) ready.resolve();
      await release.promise;
      return { requesterUserId: 'user', expiresAt: Date.now() + 60_000 };
    });
    if (!host.remoteControlNonce) throw new Error('missing remote nonce');
    const input = {
      sessionId: 'session-a',
      requesterUserId: 'user',
      responseKey: (await createRpcSecretRecipient()).publicKey,
      operation: { type: 'configure' as const, settings: { recoverCapacity: true } },
      proof: {
        runtimeNonce: host.remoteControlNonce,
        requestId: '15fb0a07-8fc5-471f-a7f2-66f6044ee419',
        requestToken: 'valid',
      },
    };
    const results = Promise.allSettled([host.remoteControl(input), host.remoteControl(input)]);
    await ready.promise;
    release.resolve();
    expect((await results).map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(await host.command({ type: 'settings', sessionId: 'session-a' })).toMatchObject({
      recoverCapacity: true,
    });
  });
  it('rejects a proof when the response recipient is substituted', async () => {
    const original = (await createRpcSecretRecipient()).publicKey;
    const replacement = (await createRpcSecretRecipient()).publicKey;
    const host = await workspaceFixture(undefined, undefined, async ({ intent }) => {
      if (JSON.stringify(intent.responseKey) !== JSON.stringify(original))
        throw new Error('invalid proof');
      return { requesterUserId: 'user', expiresAt: Date.now() + 60_000 };
    });
    if (!host.remoteControlNonce) throw new Error('missing remote nonce');
    await expect(
      host.remoteControl({
        sessionId: 'session-a',
        requesterUserId: 'user',
        responseKey: replacement,
        operation: { type: 'list' },
        proof: {
          runtimeNonce: host.remoteControlNonce,
          requestId: '15fb0a07-8fc5-471f-a7f2-66f6044ee419',
          requestToken: 'valid',
        },
      })
    ).rejects.toThrow('invalid proof');
  });
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
    expect(meta).toMatchObject({
      messageQueueUpdateVersion: {
        updatedAt: expect.any(Number),
        frontiers: expect.any(Array),
      },
    });
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
  it('cancels a queued continuation whose authorization is durably revoked', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const meta = {
      id: 'session-a',
      machineId: 'machine',
      userId: 'user',
      collaborationStopped: false,
    };
    const host = await workspaceFixture(meta);
    const invocation: AutomationInvocation = {
      target: { kind: 'existing', sessionId: 'session-a', onUnavailable: 'blocked' },
      input: { kind: 'external_event', ref: 'event' },
      ifBusy: 'enqueue',
    };
    const draft: AutomationRuleDraft = {
      id: 'rule',
      name: 'resume',
      scope: { workspaceId: 'workspace' },
      selector: { types: ['test.event'] },
      enabled: true,
      handler: { kind: 'agent', invocation },
      grants: {
        actions: ['agent.invoke'],
        sessionIds: ['session-a'],
        agentRoleIds: [],
        bindingIds: [],
        allowLinkedSession: false,
        allowCapacityAttempt: false,
      },
      budget: { maxActionsPerEvent: 10, maxInvocationsPerCorrelation: 2, maxDepth: 4 },
    };
    const rule = host.ledger.upsert(draft, 'user', Date.now());
    host.ledger.publish({
      id: 'e1',
      source: 'test',
      type: 'test.event',
      version: 1,
      subject: 'subject',
      observedAt: Date.now(),
      scope: { workspaceId: 'workspace', sessionId: 'session-a' },
      data: {},
      provenance: 'poll',
      completeness: 'observed',
      depth: 0,
    });
    const receipt = host.ledger.accept(
      required(host.ledger.deliveries()[0]),
      { key: 'step', action: { kind: 'agent.invoke', parameters: invocation } },
      Date.now()
    );
    host.ledger.update(receipt.id, 'accepted', { state: 'queued' }, Date.now());
    await host.testDocument.pushMessageQueue({
      task: 'resume',
      userId: 'user',
      userTurnId: receipt.turnId,
      operationId: receipt.id,
      timestamp: new Date().toISOString(),
      isEditing: false,
      editingStartedAt: undefined,
      project: undefined,
    });
    meta.collaborationStopped = true;
    await host.wake();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.ledger.receipt(receipt.id)).toMatchObject({ state: 'queued' });
    host.ledger.upsert({ ...draft, enabled: false }, 'user', Date.now(), rule.revision);
    await host.wake();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.ledger.receipt(receipt.id)).toMatchObject({
      state: 'cancelled',
      reason: 'authorization_revoked',
    });
    const queue = await (await createSessionBackend(host.testDocument)).getMessageQueue();
    expect(queue).toHaveLength(0);
  });
  it('supersedes a queued continuation whose admission guard went stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const host = await workspaceFixture({
      id: 'session-a',
      machineId: 'machine',
      userId: 'user',
      collaborationStopped: false,
    });
    const invocation: AutomationInvocation = {
      target: { kind: 'existing', sessionId: 'session-a', onUnavailable: 'blocked' },
      input: { kind: 'external_event', ref: 'event' },
      ifBusy: 'enqueue',
    };
    const draft: AutomationRuleDraft = {
      id: 'rule',
      name: 'deliver',
      scope: { workspaceId: 'workspace' },
      selector: { types: ['test.event'] },
      enabled: true,
      handler: { kind: 'agent', invocation },
      grants: {
        actions: ['agent.invoke'],
        sessionIds: ['session-a'],
        agentRoleIds: [],
        bindingIds: [],
        allowLinkedSession: false,
        allowCapacityAttempt: false,
      },
      budget: { maxActionsPerEvent: 10, maxInvocationsPerCorrelation: 2, maxDepth: 4 },
    };
    const rule = host.ledger.upsert(draft, 'user', Date.now());
    host.ledger.publish({
      id: 'e1',
      source: 'test',
      type: 'test.event',
      version: 1,
      subject: 'subject',
      observedAt: Date.now(),
      scope: { workspaceId: 'workspace', sessionId: 'session-a' },
      data: {},
      provenance: 'poll',
      completeness: 'observed',
      depth: 0,
    });
    const receipt = host.ledger.accept(
      required(host.ledger.deliveries()[0]),
      {
        key: 'step',
        guard: {
          kind: 'session.delivery.current',
          parameters: { sessionId: 'session-a', eventId: 'ev-stale' },
        },
        action: { kind: 'agent.invoke', parameters: invocation },
      },
      Date.now()
    );
    const origin = {
      invocationId: receipt.id,
      ruleId: rule.id,
      ruleRevision: rule.revision,
      eventRef: receipt.event.id,
      authorizationUserId: 'user',
    };
    host.ledger.update(
      receipt.id,
      'accepted',
      { state: 'queued', prepared: { kind: 'queue', config: { _lodyAutomation: origin } } },
      Date.now()
    );
    await host.testDocument.pushMessageQueue({
      task: 'deliver',
      userId: 'user',
      userTurnId: receipt.turnId,
      operationId: receipt.id,
      timestamp: new Date().toISOString(),
      isEditing: false,
      editingStartedAt: undefined,
      project: undefined,
    });
    expect(
      await host.testAdmission({
        sessionId: 'session-a' as SessionId,
        turnId: receipt.turnId,
        userId: 'user',
        origin,
      })
    ).toBe(false);
    await host.wake();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.ledger.receipt(receipt.id)).toMatchObject({
      state: 'superseded',
      reason: 'guard:delivery_step_replaced',
    });
    const queue = await (await createSessionBackend(host.testDocument)).getMessageQueue();
    expect(queue).toHaveLength(0);
  });
  it('manages an owned Session’s automations from another active Session', async () => {
    const host = await workspaceFixture({
      id: 'session-b',
      machineId: 'machine',
      userId: 'user',
      collaborationStopped: false,
    });
    const wait = (await host.command(
      { type: 'register', sessionId: 'session-b', program: '() => false', intervalMs: 30000 },
      'session-a'
    )) as { id: string; sessionId: string };
    expect(wait.sessionId).toBe('session-b');
    expect(await host.command({ type: 'list', sessionId: 'session-b' }, 'session-a')).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: wait.id })])
    );
    expect(await host.command({ type: 'show', id: wait.id }, 'session-a')).toMatchObject({
      sessionId: 'session-b',
    });
    await host.command(
      { type: 'configure', sessionId: 'session-b', settings: { archiveAfterMerge: true } },
      'session-a'
    );
    expect(
      await host.command({ type: 'settings', sessionId: 'session-b' }, 'session-a')
    ).toMatchObject({ archiveAfterMerge: true });
    expect(
      await host.command({ type: 'activities', sessionId: 'session-b' }, 'session-a')
    ).toMatchObject({ items: expect.any(Array) });
    await host.command({ type: 'cancel', id: wait.id }, 'session-a');
    expect(host.ledger.wait(wait.id)?.state).toBe('cancelled');
    await expect(host.command({ type: 'list' }, 'inactive-session')).rejects.toThrow(
      'AUTOMATION_ACTIVE_AUTHOR_REQUIRED'
    );
  });
  it('lets an Agent working for a teammate manage automations in a Session the teammate can edit', async () => {
    const host = await workspaceFixture({
      id: 'session-a',
      machineId: 'machine',
      userId: 'teammate',
      collaborationStopped: false,
    });
    host.testEditors.add('teammate');
    host.testAuthors.set('session-a', 'teammate');
    const wait = (await host.command(
      { type: 'register', program: '() => false', intervalMs: 30_000 },
      'session-a'
    )) as { id: string };
    expect(host.ledger.wait(wait.id)?.ownerUserId).toBe('teammate');
    expect(await host.command({ type: 'list', sessionId: 'session-a' }, 'session-a')).toEqual([
      expect.objectContaining({ id: wait.id }),
    ]);
    host.testEditors.delete('teammate');
    await expect(
      host.command({ type: 'list', sessionId: 'session-a' }, 'session-a')
    ).rejects.toThrow('AUTOMATION_PERMISSION_DENIED');
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

describe('Managed runs', () => {
  const gated = (release: string, exitCode: number) => ({
    command: process.execPath,
    args: [
      '-e',
      `const fs = require('node:fs'); process.stdout.write('started\\n'); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); process.stdout.write('finished\\n'); process.exit(${exitCode}); } }, 10);`,
      release,
    ],
  });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('keeps the Session unsettled while the command runs and resumes it with the exit facts', async () => {
    const meta = {
      id: 'session-a',
      machineId: 'machine',
      userId: 'user',
      collaborationStopped: false,
      cliType: 'builtin',
      agentType: 'synthetic',
    };
    const host = await workspaceFixture(meta);
    const release = path.join(host.testRoot, 'release');
    const run = (await host.command(
      { type: 'run', ...gated(release, 3), reason: 'Run the slow suite' },
      'session-a'
    )) as { id: string; run: { logPath: string } };
    expect(await host.command({ type: 'run', ...gated(release, 3) }, 'session-a')).toMatchObject({
      id: run.id,
    });
    await vi.waitFor(() => expect(host.ledger.wait(run.id)?.run?.pid).toBeTypeOf('number'));
    expect(host.ledger.wait(run.id)?.state).toMatch(/waiting|checking/);
    expect(host.ledger.hasSessionWork('session-a')).toBe(true);

    writeFileSync(release, '');
    await vi.waitFor(() => expect(host.ledger.wait(run.id)?.state).toBe('matched'));
    const matched = host.ledger.wait(run.id);
    expect(matched?.result?.resumeText).toContain('exited with code 3');
    expect(matched?.result?.resumeText).toContain(run.run.logPath);
    expect(matched?.result?.payload).toMatchObject({
      outcome: 'exited',
      exitCode: 3,
      signal: null,
      logPath: run.run.logPath,
      logTruncated: false,
      outputTail: 'started\nfinished\n',
    });
    expect(readFileSync(run.run.logPath, 'utf8')).toBe('started\nfinished\n');
    const invocationId = matched?.invocationId;
    if (!invocationId) throw new Error('missing continuation');
    await vi.waitFor(() =>
      expect(host.ledger.receipt(invocationId)?.state).toMatch(/queued|running|settled/)
    );
    const queue = await (await createSessionBackend(host.testDocument)).getMessageQueue();
    expect(queue[0]?.task).toContain('exited with code 3');
  });

  it('terminates the command on cancel', async () => {
    const host = await workspaceFixture();
    const run = (await host.command(
      { type: 'run', ...gated(path.join(host.testRoot, 'never'), 0) },
      'session-a'
    )) as { id: string };
    await vi.waitFor(() => expect(host.ledger.wait(run.id)?.run?.pid).toBeTypeOf('number'));
    const pid = host.ledger.wait(run.id)?.run?.pid ?? 0;
    expect(alive(pid)).toBe(true);
    await host.command({ type: 'cancel', id: run.id }, 'session-a');
    expect(host.ledger.wait(run.id)?.state).toBe('cancelled');
    expect(alive(pid)).toBe(false);
    expect(host.ledger.hasSessionWork('session-a')).toBe(false);
  });

  it('reports a run whose owner stopped as interrupted and never starts it again', async () => {
    const meta = {
      id: 'session-a',
      machineId: 'machine',
      userId: 'user',
      collaborationStopped: false,
    };
    const host = await workspaceFixture(meta);
    const run = (await host.command(
      { type: 'run', ...gated(path.join(host.testRoot, 'never'), 0) },
      'session-a'
    )) as { id: string; run: { logPath: string } };
    await vi.waitFor(() => expect(host.ledger.wait(run.id)?.run?.pid).toBeTypeOf('number'));
    await vi.waitFor(() => expect(readFileSync(run.run.logPath, 'utf8')).toBe('started\n'));
    const pid = host.ledger.wait(run.id)?.run?.pid ?? 0;
    await host.dispose();
    owners.splice(owners.indexOf(host), 1);
    expect(alive(pid)).toBe(false);

    const restarted = await workspaceFixture(meta, host.testRoot);
    await restarted.wake();
    await vi.waitFor(() => expect(restarted.ledger.wait(run.id)?.state).toBe('matched'));
    const matched = restarted.ledger.wait(run.id);
    expect(matched?.result?.resumeText).toContain('Lody did not run it again');
    expect(matched?.result?.payload).toMatchObject({ outcome: 'interrupted' });
    expect(readFileSync(run.run.logPath, 'utf8')).toBe('started\n');
  });

  it('reports a command that cannot start and rejects a working directory outside the Session', async () => {
    const host = await workspaceFixture();
    await expect(
      host.command({ type: 'run', command: process.execPath, cwd: '..' }, 'session-a')
    ).rejects.toThrow('AUTOMATION_EXEC_INVALID_CWD');
    const run = (await host.command(
      { type: 'run', command: path.join(host.testRoot, 'missing-binary') },
      'session-a'
    )) as { id: string };
    await vi.waitFor(() => expect(host.ledger.wait(run.id)?.state).toBe('matched'));
    expect(host.ledger.wait(run.id)?.result?.payload).toMatchObject({
      outcome: 'spawn_failed',
      exitCode: null,
    });
    expect(host.ledger.wait(run.id)?.result?.resumeText).toContain('could not start');
  });
});
