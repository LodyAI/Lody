import fs from 'node:fs';
import { Effect } from 'effect';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import * as managedRuntime from '../src/agent/managed-agent-runtime';
import * as processFacade from '@lody/shared/node/process';
import {
  decryptCodeCollabV2RpcPayload,
  encryptCodeCollabV2RpcPayload,
} from '@lody/loro-streams-rpc';
import type { E2eeQueryInput } from '@lody/shared/e2ee-rpc';
import { encryptedRpcFixture } from '../../../packages/loro-streams-rpc/tests/fixtures/e2ee-native-fixture';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSessionRoomId,
  machineFlockKeys,
  getMachineFlockLocalProjects,
  readMachineFlockRowsFromFlock,
  writeMachineFlockRowToFlock,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { Flock } from '@loro-dev/flock-wasm';
import { MessageHandler } from '../src/lib/message-handler';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { ISession, SessionManager } from '../src/session/session-manager';
import { Session, getDefaultSessionWorkdir } from '../src/session/session';
import type { Logger } from '../src/utils/logger';
import { createTestCloudPort } from './test-cloud-port';

const sessionId = 'preview-chat' as SessionId;
const parentId = 'preview-parent' as SessionId;
const workspaceId = 'synthetic-workspace' as WorkspaceId;
const machineId = 'fixture-machine';
const content = 'A synthetic artifact survives runtime eviction.\n';
const logger: Logger = {
  info() {},
  warn() {},
  error() {},
  success() {},
  debug() {},
  trace() {},
  setLevel() {},
  child: () => logger,
  close: async () => {},
};

describe('MessageHandler file preview workspace lifecycle', () => {
  let dataDir: string;
  let handler: MessageHandler;
  let resident: ISession | null;
  let records: Map<string, { meta: Partial<SessionMeta>; deleted?: boolean }>;
  let restoreCodeCollab: () => void;
  let manager: SessionManager;
  let document: LoroDocumentManager;
  let localProjects: Flock;

  beforeEach(() => {
    dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lody-chat-preview-')));
    vi.stubEnv('LODY_DATA_DIR', dataDir);
    resident = null;
    localProjects = new Flock();
    records = new Map([
      [getSessionRoomId(sessionId), { meta: { machineId, userId: 'user-1' } }],
      [getSessionRoomId(parentId), { meta: { machineId, userId: 'user-1' } }],
    ]);
    const unexpected = () => {
      throw new Error('Preview must not start an agent or mutate documents');
    };
    manager = {
      getSession: () => resident,
      getPendingSession: () => undefined,
      resolveLocalProjectRootPath: async (id: string) =>
        getMachineFlockLocalProjects(
          readMachineFlockRowsFromFlock(localProjects, { families: ['localProject'] })
        )[id as never]?.rootPath ?? null,
      createSession: unexpected,
      on() {},
      setRequestPermissionHandler() {},
      cleanUp: async () => {},
    } as unknown as SessionManager;
    document = {
      isTransportConnected: () => true,
      peekLocalProjectRootPath: (_machine: string, id: string) =>
        getMachineFlockLocalProjects(
          readMachineFlockRowsFromFlock(localProjects, { families: ['localProject'] })
        )[id as never]?.rootPath ?? null,
      markMachineFlockDocDirty: unexpected,
      repo: {
        getDocMeta: async (id: string) => records.get(id),
        watch: () => ({ unsubscribe() {} }),
        openFlockDoc: unexpected,
        openDetachedFlockDoc: unexpected,
      },
      getOrCreateSessionDoc: unexpected,
      sendMachineHeartbeat: unexpected,
    } as unknown as LoroDocumentManager;
    handler = new MessageHandler(manager, document, logger, {
      token: 'synthetic-token',
      workspaceId,
      userId: 'user-1',
      machineId,
      machineName: 'synthetic-machine',
      cliVersion: '0.0.0',
      cloudPort: createTestCloudPort(),
    });
    // A successful preview must remain possible with all Code Collab access
    // forbidden, including watcher activation and Flock publication.
    const internals = handler as unknown as { codeCollabV2Service: object };
    const service = internals.codeCollabV2Service;
    internals.codeCollabV2Service = new Proxy({}, { get: unexpected });
    restoreCodeCollab = () => {
      internals.codeCollabV2Service = service;
    };
  });

  afterEach(async () => {
    restoreCodeCollab();
    await handler.cleanup();
    vi.unstubAllEnvs();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function encryptedHandler() {
    restoreCodeCollab();
    await handler.cleanup();
    handler = new MessageHandler(manager, document, logger, {
      token: 'synthetic-token',
      workspaceId,
      userId: 'user-1',
      machineId,
      machineName: 'synthetic-machine',
      cliVersion: '0.0.0',
      encryptedWorkspace: true,
      cloudPort: createTestCloudPort({
        billing: {
          getWorkspaceEntitlement: async () => ({
            effectivePlanTier: 'pro',
            checkoutPending: false,
          }),
        } as never,
      }),
    });
    restoreCodeCollab = () => {};
  }

  function diskSnapshot(root = dataDir): unknown {
    return fs
      .readdirSync(root)
      .sort()
      .map((name) => {
        const file = path.join(root, name);
        const stat = fs.lstatSync(file);
        return [
          name,
          stat.mode,
          stat.isSymbolicLink()
            ? fs.readlinkSync(file)
            : stat.isDirectory()
              ? diskSnapshot(file)
              : fs.readFileSync(file).toString('hex'),
        ];
      });
  }

  // The encrypted handler has already received the verified signer/read grant.
  // Test native admission as an actual Guest too, and bypass it at the server
  // boundary so an older/malicious client cannot restore the removed methods.
  it.each([
    ['machine/pi-extensions', {}],
    ['machine/memory', { action: 'list', providerId: 'nowledge-mem' }],
    ['project/probe-local-member', { localProjectId: 'synthetic', requestedByUserId: 'user-1' }],
    ['local-project/git-state', { localProjectId: 'synthetic', requestedByUserId: 'user-1' }],
    ['session/history-read', { sessionId, query: { kind: 'count' } }],
    [
      'session/history-watch',
      { sessionId, query: { kind: 'watchChanges', checkpoint: 'synthetic', waitMs: 100 } },
    ],
    ['code-collab/open-current-diff', { sessionId, path: 'artifact.txt' }],
    ['code-collab/open-all-changes-diff', { sessionId }],
    ['code-collab/open-turn-diff', { sessionId, path: 'artifact.txt', turnId: 'synthetic' }],
  ])('denies Guest encrypted read query %s before machine work', async (method, params) => {
    await encryptedHandler();
    const f = encryptedRpcFixture({ guest: true });
    const processRun = vi
      .spyOn(processFacade, 'runCommandTextLegacy')
      .mockImplementation(async () => {
        throw new Error('Removed query reached the process boundary');
      });
    try {
      expect(
        [...f.ledger.view().inspectState().members.values()].some((m) => m.role === 'guest')
      ).toBe(true);
      const before = diskSnapshot();
      const input = {
        queryId: 'denied',
        method,
        params:
          method.startsWith('session/history-') || method.startsWith('code-collab/')
            ? await encryptCodeCollabV2RpcPayload(sessionId, params)
            : params,
      } as E2eeQueryInput;
      const admitted = await Effect.runPromise(f.sender.prepareQuery(f.machineId, input)).then(
        () => true,
        () => false
      );
      const handled = await handler
        .readEncryptedQuery(input, Number.MAX_SAFE_INTEGER, new AbortController().signal)
        .then(
          () => true,
          () => false
        );
      expect({ admitted, handled, disk: diskSnapshot() }).toEqual({
        admitted: false,
        handled: false,
        disk: before,
      });
    } finally {
      processRun.mockRestore();
      f.close();
    }
  });

  it('refuses Guest Pi discovery without installing its real synthetic archive or launching its scanner', async () => {
    await encryptedHandler();
    const source = path.join(dataDir, 'archive-source');
    fs.mkdirSync(path.join(source, 'package'), { recursive: true });
    fs.writeFileSync(path.join(source, 'package', 'scan.js'), 'synthetic scanner');
    const archive = path.join(dataDir, 'synthetic-pi.tgz');
    await tar.c({ file: archive, cwd: source, gzip: true }, ['package']);
    const bytes = fs.readFileSync(archive);
    const downloads: string[] = [];
    const processEvents: string[] = [];
    const runtime = new managedRuntime.ManagedAgentRuntimeManager({
      rootDir: path.join(dataDir, 'agent-binaries'),
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: '24.22.1',
      runtimeBaseUrl: 'https://runtime.example.test',
      fetchImpl: async (url) => {
        downloads.push(String(url));
        return new Response(bytes);
      },
    });
    const definition = runtime.getDefinition('pi');
    const original = definition.platforms.node;
    definition.platforms.node = {
      fileName: 'synthetic-pi.tgz',
      compression: 'gzip',
      cmd: 'package/scan.js',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const managerRead = vi
      .spyOn(managedRuntime, 'getManagedAgentRuntimeManager')
      .mockReturnValue(runtime);
    // Deterministic process boundary: retain start/exit events, never run real
    // children. The real installer still verifies, extracts and writes its cache.
    const run = vi
      .spyOn(processFacade, 'runCommandTextLegacy')
      .mockImplementation(async (command) => {
        processEvents.push(JSON.stringify({ command: command.command, args: command.args }));
        return {
          stdout: JSON.stringify({ version: 1, agentDir: source, extensions: [], warnings: [] }),
          stderr: '',
          code: 0,
          signal: null,
        };
      });
    try {
      const before = diskSnapshot();
      const installed = await runtime.getRuntimeStatus('pi');
      const outcome = await handler
        .readEncryptedQuery(
          { queryId: 'pi-install', method: 'machine/pi-extensions' as never, params: {} },
          Number.MAX_SAFE_INTEGER,
          new AbortController().signal
        )
        .then(
          () => 'allowed',
          () => 'denied'
        );
      expect({
        outcome,
        disk: diskSnapshot(),
        runtime: await runtime.getRuntimeStatus('pi'),
        downloads,
        processEvents,
      }).toEqual({
        outcome: 'denied',
        disk: before,
        runtime: installed,
        downloads: [],
        processEvents: [],
      });
    } finally {
      run.mockRestore();
      managerRead.mockRestore();
      definition.platforms.node = original;
    }
  });

  it('keeps Guest encrypted file reads from recreating an evicted active chat directory', async () => {
    await encryptedHandler();
    resident = new Session({ sessionId } as never, logger);
    const before = diskSnapshot();
    const params = await encryptCodeCollabV2RpcPayload(sessionId, {
      v: 3,
      sessionId,
      path: 'artifact.txt',
    });
    const result = await handler.readEncryptedQuery(
      { queryId: 'cold', method: 'file/preview', params },
      Number.MAX_SAFE_INTEGER,
      new AbortController().signal
    );
    expect(diskSnapshot()).toEqual(before);
    expect(result).toMatchObject({ error: { code: 'workspace_root_unavailable' } });
  });

  it.each([
    ['machine/status', {}, { success: true }],
    ['machine/ping', { requestId: 'synthetic' }, { success: true, message: 'pong' }],
    ['machine/acp-binary-status', { agentType: 'pi' }, { success: true, status: 'not-installed' }],
    ['session/live-status', { sessionId }, { success: true }],
    [
      'file/preview',
      { v: 3, sessionId, path: 'artifact.txt' },
      { status: 'ok', content: { text: content } },
    ],
    [
      'file/download-chunk',
      { sessionId, path: 'artifact.txt', offset: 0 },
      { status: 'ok', data: Buffer.from(content).toString('base64') },
    ],
    [
      'code-collab/open-text',
      { sessionId, path: 'artifact.txt' },
      { status: 'ok', text: { text: content } },
    ],
    [
      'code-collab/refresh-text',
      { sessionId, path: 'artifact.txt', digest: `sha256:${'0'.repeat(64)}` },
      { status: 'updated', text: { text: content } },
    ],
    [
      'code-collab/lsp-definition',
      { sessionId, path: 'artifact.txt' },
      { status: 'unsupported', code: 'lsp_not_wired' },
    ],
    [
      'code-collab/lsp-references',
      { sessionId, path: 'artifact.txt' },
      { status: 'unsupported', code: 'lsp_not_wired' },
    ],
  ])(
    'serves Guest encrypted read query %s without changing machine files or processes',
    async (method, payload, expected) => {
      await encryptedHandler();
      writeArtifact();
      const f = encryptedRpcFixture({ guest: true });
      const processEvents: string[] = [];
      const runtime = new managedRuntime.ManagedAgentRuntimeManager({
        rootDir: path.join(dataDir, 'missing-agent-binaries'),
        platform: 'darwin',
        arch: 'arm64',
        nodeVersion: '24.22.1',
        fetchImpl: async () => {
          throw new Error('Query tried to download');
        },
      });
      const managerRead = vi
        .spyOn(managedRuntime, 'getManagedAgentRuntimeManager')
        .mockReturnValue(runtime);
      const processRun = vi
        .spyOn(processFacade, 'runCommandTextLegacy')
        .mockImplementation(async (command) => {
          processEvents.push(command.command);
          throw new Error('Query tried to start a process');
        });
      try {
        const before = diskSnapshot();
        const wrapped = method.startsWith('file/') || method.startsWith('code-collab/');
        const input = {
          queryId: 'guest-read',
          method,
          params: wrapped ? await encryptCodeCollabV2RpcPayload(sessionId, payload) : payload,
        } as E2eeQueryInput;
        const prepared = await Effect.runPromise(f.sender.prepareQuery(f.machineId, input));
        const opened = await Effect.runPromise(
          f.receiver.openQuery(f.machineId, prepared.frameHex)
        );
        const outcome = await handler.readEncryptedQuery(
          opened.input,
          Number.MAX_SAFE_INTEGER,
          new AbortController().signal
        );
        const frames = await Effect.runPromise(
          f.receiver.queryResponse(f.machineId, opened, outcome)
        );
        let accepted;
        for (const frame of frames)
          accepted = await Effect.runPromise(
            f.sender.acceptQueryResponse(f.machineId, input, Buffer.from(frame).toString('hex'))
          );
        expect(accepted).toHaveProperty('result');
        const result = accepted && 'result' in accepted ? accepted.result : undefined;
        expect(
          wrapped ? await decryptCodeCollabV2RpcPayload(result as never, sessionId) : result
        ).toMatchObject(expected);
        expect({ disk: diskSnapshot(), processEvents }).toEqual({
          disk: before,
          processEvents: [],
        });
      } finally {
        processRun.mockRestore();
        managerRead.mockRestore();
        f.close();
      }
    }
  );

  it.each(['absent', 'stale'] as const)(
    'never repairs a %s project member link for a Guest file read',
    async (link) => {
      await encryptedHandler();
      const { root } = writeArtifact();
      const member = path.join(dataDir, 'member');
      fs.mkdirSync(member);
      const wrong = path.join(dataDir, 'wrong-member');
      fs.mkdirSync(wrong);
      if (link === 'stale') fs.symlinkSync(wrong, path.join(root, 'linked'));
      resident = new Session({ sessionId } as never, logger, root);
      records.set(getSessionRoomId(sessionId), {
        meta: {
          machineId,
          projectRun: {
            members: {
              linked: {
                access: 'link',
                src: { kind: 'local', machineId, localProjectId: 'local-member' },
                placement: { kind: 'root', dir: 'linked' },
              },
            },
          } as never,
        },
      });
      writeMachineFlockRowToFlock(
        localProjects,
        {
          key: machineFlockKeys.localProject('local-member' as never),
          value: {
            id: 'local-member',
            name: 'Synthetic member',
            rootPath: member,
            createdAtMs: 1,
          },
        },
        1
      );
      const before = diskSnapshot();
      const params = await encryptCodeCollabV2RpcPayload(sessionId, {
        v: 3,
        sessionId,
        path: 'artifact.txt',
      });
      const response = await handler.readEncryptedQuery(
        { queryId: 'group', method: 'file/preview', params },
        Number.MAX_SAFE_INTEGER,
        new AbortController().signal
      );
      expect(response).toHaveProperty('result');
      expect(diskSnapshot()).toEqual(before);
    }
  );

  it.each(['loaded', 'unloaded'] as const)(
    'uses only a %s machine project snapshot for encrypted file paths',
    async (state) => {
      await encryptedHandler();
      const root = path.join(dataDir, 'local-root');
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'artifact.txt'), content);
      records.set(getSessionRoomId(sessionId), {
        meta: { machineId, project: { kind: 'local', localProjectId: 'local-member' as never } },
      });
      if (state === 'loaded')
        writeMachineFlockRowToFlock(
          localProjects,
          {
            key: machineFlockKeys.localProject('local-member' as never),
            value: {
              id: 'local-member',
              name: 'Synthetic member',
              rootPath: root,
              createdAtMs: 1,
            },
          },
          1
        );
      const before = diskSnapshot();
      const params = await encryptCodeCollabV2RpcPayload(sessionId, {
        v: 3,
        sessionId,
        path: 'artifact.txt',
      });
      const response = await handler.readEncryptedQuery(
        { queryId: 'project', method: 'file/preview', params },
        Number.MAX_SAFE_INTEGER,
        new AbortController().signal
      );
      if (state === 'loaded')
        expect(
          await decryptCodeCollabV2RpcPayload(response.result as never, sessionId)
        ).toMatchObject({ status: 'ok', content: { text: content } });
      else expect(response).toMatchObject({ error: { code: 'workspace_root_unavailable' } });
      expect(diskSnapshot()).toEqual(before);
    }
  );

  it('refuses Guest Markdown worktree discovery before starting Git', async () => {
    await encryptedHandler();
    const { root } = writeArtifact();
    fs.mkdirSync(path.join(root, '.git'));
    const processEvents: string[] = [];
    const processRun = vi
      .spyOn(processFacade, 'runCommandTextLegacy')
      .mockImplementation(async (command) => {
        processEvents.push(command.command);
        throw new Error('Query tried to start Git');
      });
    try {
      const before = diskSnapshot();
      const params = await encryptCodeCollabV2RpcPayload(sessionId, {
        v: 3,
        sessionId,
        path: 'artifact.txt',
        resolveMarkdownLink: true,
      });
      const response = await handler.readEncryptedQuery(
        { queryId: 'markdown', method: 'file/preview', params },
        Number.MAX_SAFE_INTEGER,
        new AbortController().signal
      );
      expect(
        await decryptCodeCollabV2RpcPayload(response.result as never, sessionId)
      ).toMatchObject({ status: 'error', code: 'unsupported_protocol' });
      expect({ disk: diskSnapshot(), processEvents }).toEqual({ disk: before, processEvents: [] });
    } finally {
      processRun.mockRestore();
    }
  });

  it('rejects cross-machine, cross-workspace and session-scoped project probes before filesystem access', async () => {
    for (const scope of [
      { machineId: 'other' },
      { workspaceId: 'other' },
      { ownerSessionId: sessionId },
    ]) {
      expect(
        await handler.handleLocalMachineRpc({
          machineId,
          workspaceId,
          ...scope,
          method: 'project/probe-local-member',
          params: { localProjectId: 'unregistered' },
        })
      ).toEqual({ ok: false, error: 'Project group probe scope mismatch' });
    }
  });

  function writeArtifact(id = sessionId, text = content) {
    const root = getDefaultSessionWorkdir(id);
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'artifact.txt');
    fs.writeFileSync(file, text);
    return { root, file };
  }

  function request(
    method: 'file/preview' | 'file/resolve-local',
    file = 'artifact.txt',
    ownerSessionId?: SessionId
  ) {
    return handler.handleLocalMachineRpc({
      method,
      machineId,
      workspaceId,
      ownerSessionId,
      params: { v: 3, sessionId, path: file },
    });
  }

  it.each(['relative', 'absolute'] as const)(
    'keeps %s previews readable after runtime eviction',
    async (kind) => {
      const { root, file } = writeArtifact();
      resident = {
        getHostWorkdir: () => root,
        getWorkdir: () => root,
        getParentSessionId: () => undefined,
      } as ISession;
      const requestedPath = kind === 'absolute' ? file : 'artifact.txt';
      const warm = await request('file/preview', requestedPath);
      expect(warm).toMatchObject({
        ok: true,
        result: { status: 'ok', content: { text: content } },
      });
      resident = null;
      expect(await request('file/preview', requestedPath)).toEqual(warm);
      expect(await request('file/resolve-local', requestedPath)).toMatchObject({
        ok: true,
        result: { status: 'local-file', absolutePath: file, external: false },
      });
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
    }
  );

  it('resolves a cold child to its parent directory and preserves the owner check', async () => {
    records.set(getSessionRoomId(sessionId), { meta: { machineId, parentSessionId: parentId } });
    writeArtifact(sessionId, 'Wrong child directory');
    const { file } = writeArtifact(parentId);
    expect(await request('file/preview', 'artifact.txt', parentId)).toMatchObject({
      ok: true,
      result: { status: 'ok', content: { text: content } },
    });
    expect(await request('file/resolve-local', 'artifact.txt', parentId)).toMatchObject({
      ok: true,
      result: { status: 'local-file', absolutePath: file },
    });
    expect(await request('file/preview', 'artifact.txt', sessionId)).toMatchObject({
      ok: true,
      result: { status: 'error', code: 'permission_denied' },
    });
  });

  it.each(['file/preview', 'file/resolve-local'] as const)(
    'does not create a missing chat directory for %s',
    async (method) => {
      expect(await request(method)).toMatchObject({
        ok: true,
        result: { status: 'error', code: 'workspace_root_unavailable' },
      });
      expect(fs.existsSync(path.join(dataDir, 'chats'))).toBe(false);
    }
  );

  it.each(['root', 'child'] as const)(
    'resolves an absolute local artifact without the %s workspace directory',
    async (kind) => {
      if (kind === 'child') {
        records.set(getSessionRoomId(sessionId), {
          meta: { machineId, parentSessionId: parentId },
        });
      }
      const file = path.join(dataDir, 'external.txt');
      fs.writeFileSync(file, content);
      expect(
        await request('file/resolve-local', file, kind === 'child' ? parentId : sessionId)
      ).toMatchObject({
        ok: true,
        result: { status: 'local-file', absolutePath: file, path: file, external: true },
      });
      expect(await request('file/preview', file)).toMatchObject({
        ok: true,
        result: { status: 'error', code: 'workspace_root_unavailable' },
      });
      expect(await request('file/resolve-local', 'external.txt')).toMatchObject({
        ok: true,
        result: { status: 'error', code: 'workspace_root_unavailable' },
      });
      expect(fs.existsSync(path.join(dataDir, 'chats'))).toBe(false);
    }
  );

  it('checks local owner identity before resolving an absolute artifact without a workspace', async () => {
    const file = path.join(dataDir, 'external.txt');
    fs.writeFileSync(file, content);
    records.set(getSessionRoomId(sessionId), { meta: { machineId, parentSessionId: parentId } });
    expect(await request('file/resolve-local', file, sessionId)).toMatchObject({
      ok: true,
      result: { status: 'error', code: 'permission_denied' },
    });
    for (const meta of [
      { machineId: 'another-machine' },
      { machineId, isArchived: true },
      { machineId, parentSessionId: 'nested-parent' as SessionId },
    ]) {
      records.set(getSessionRoomId(parentId), { meta });
      expect(await request('file/resolve-local', file, parentId)).toMatchObject({
        ok: true,
        result: { status: 'error', code: 'permission_denied' },
      });
    }
    records.delete(getSessionRoomId(parentId));
    expect(await request('file/resolve-local', file, parentId)).toMatchObject({
      ok: true,
      result: { status: 'error', code: 'session_not_found' },
    });
  });

  it('reports a missing file in an existing chat as file_not_found', async () => {
    writeArtifact();
    expect(await request('file/preview', 'missing.txt')).toMatchObject({
      ok: true,
      result: { status: 'error', code: 'file_not_found' },
    });
  });

  it.each(['session', 'parent'] as const)(
    'rejects invalid %s metadata even when its files exist',
    async (target) => {
      writeArtifact();
      writeArtifact(parentId);
      if (target === 'parent') {
        records.set(getSessionRoomId(sessionId), {
          meta: { machineId, parentSessionId: parentId },
        });
      }
      const id = getSessionRoomId(target === 'parent' ? parentId : sessionId);
      const cases = [
        { record: undefined, code: 'session_not_found' },
        { record: { meta: { machineId }, deleted: true }, code: 'session_not_found' },
        { record: { meta: { machineId, isArchived: true } }, code: 'permission_denied' },
        { record: { meta: { machineId: 'another-machine' } }, code: 'permission_denied' },
        { record: { meta: { machineId, isWorktree: true } }, code: 'workspace_root_unavailable' },
      ];
      for (const { record, code } of cases) {
        if (record) records.set(id, record);
        else records.delete(id);
        for (const method of ['file/preview', 'file/resolve-local'] as const) {
          expect(await request(method)).toMatchObject({
            ok: true,
            result: { status: 'error', code },
          });
        }
      }
    }
  );

  it('does not substitute a chat directory for an unresolved parent project or nested parent', async () => {
    writeArtifact();
    writeArtifact(parentId);
    records.set(getSessionRoomId(sessionId), { meta: { machineId, parentSessionId: parentId } });
    for (const extra of [
      { repoFullName: 'synthetic/project' },
      { parentSessionId: 'nested-parent' as SessionId },
    ]) {
      records.set(getSessionRoomId(parentId), { meta: { machineId, ...extra } });
      expect(await request('file/preview')).toMatchObject({
        ok: true,
        result: { status: 'error', code: 'workspace_root_unavailable' },
      });
    }
  });
});
