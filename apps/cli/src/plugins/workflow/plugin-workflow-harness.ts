import { readFile, realpath, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import { Cause, Deferred, Effect, Exit, Scope } from 'effect';
import { spawnProcess, ProcessReleaseFailed } from '@lody/shared/node/process';
import type { PluginManifest } from '@lody/shared/plugins/manifest-schema';

export async function readWorkflowContributions(directory: string, manifest: PluginManifest) {
  const root =
    manifest.skills?.length ||
    manifest.agentRoles?.length ||
    manifest.acpProviders?.length ||
    manifest.mcpServers?.length
      ? await realpath(directory)
      : directory;
  const qualify = (id: string) => `plugin:${manifest.id}:${id}`;
  const file = async (p: string) => {
    const candidate = await realpath(join(root, p));
    if (!candidate.startsWith(root + sep)) throw Error('Workflow file escapes plugin generation');
    return candidate;
  };
  async function indexed<T extends { id: string }>(entries: Promise<T>[]) {
    const result = new Map<string, T>();
    for (const entry of await Promise.all(entries)) {
      if (result.has(entry.id)) throw Error(`Duplicate workflow contribution: ${entry.id}`);
      result.set(entry.id, entry);
    }
    return result;
  }
  const skills = await indexed(
    (manifest.skills ?? []).map(async (name) => ({
      id: qualify(name),
      name,
      markdown: await readFile(await file(`skills/${name}/SKILL.md`), 'utf8'),
    }))
  );
  const mcpServers = await indexed(
    (manifest.mcpServers ?? []).map(async (server) => ({
      ...server,
      id: qualify(server.id),
      entry: await file(server.entry),
    }))
  );
  const acpProviders = await indexed(
    (manifest.acpProviders ?? []).map(async (provider) => ({
      ...provider,
      id: qualify(provider.id),
    }))
  );
  const roles = await indexed(
    (manifest.agentRoles ?? []).map(async (role) => {
      const skillIds = (role.skills ?? []).map(qualify),
        serverIds = (role.mcpServers ?? []).map(qualify);
      if (
        skillIds.some((id) => !skills.has(id)) ||
        serverIds.some((id) => !mcpServers.has(id)) ||
        (role.defaultProvider?.startsWith('plugin:') && !acpProviders.has(role.defaultProvider))
      )
        throw Error(`Unknown workflow binding: ${role.id}`);
      return {
        ...role,
        id: qualify(role.id),
        skills: skillIds,
        mcpServers: serverIds,
        prompt: await readFile(await file(role.promptPath), 'utf8'),
      };
    })
  );
  return { root, pluginId: manifest.id, roles, skills, mcpServers, acpProviders };
}
export type WorkflowContributions = Awaited<ReturnType<typeof readWorkflowContributions>>;
export const makePluginWorkflowHarness = Effect.fnUntraced(function* () {
  const generations = new Map<
    string,
    {
      rows: WorkflowContributions;
      scope: Scope.Closeable;
      managed: Set<() => Promise<void>>;
      closing: boolean;
      leases: Set<ProcessReleaseFailed>;
      config: Readonly<Record<string, unknown>>;
    }
  >();
  const remove = Effect.fnUntraced(function* (pluginId: string) {
    const old = generations.get(pluginId);
    if (old) {
      old.closing = true;
      for (const release of old.managed) yield* Effect.tryPromise(release);
      const result = yield* Effect.exit(Scope.close(old.scope, Exit.void));
      if (Exit.isFailure(result)) {
        for (const r of result.cause.reasons)
          if (r._tag === 'Die' && r.defect instanceof ProcessReleaseFailed)
            old.leases.add(r.defect);
        return yield* Effect.fail(Cause.squash(result.cause));
      }
      for (const lease of old.leases) {
        yield* lease.retryTermination();
        old.leases.delete(lease);
      }
      generations.delete(pluginId);
    }
  });
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...generations.keys()], (id) => remove(id).pipe(Effect.orDie), {
      concurrency: 'unbounded',
      discard: true,
    })
  );
  const install = Effect.fnUntraced(function* (
    pluginId: string,
    rows: WorkflowContributions,
    config: Readonly<Record<string, unknown>>
  ) {
    yield* remove(pluginId);
    generations.set(pluginId, {
      rows,
      config,
      managed: new Set(),
      closing: false,
      leases: new Set(),
      scope: yield* Scope.make(),
    });
  });
  const start = Effect.fnUntraced(function* (id: string, admit?: () => void) {
    const gen = generations.get(id.split(':')[1] ?? '');
    const server = gen?.rows.mcpServers.get(id);
    if (!gen || gen.closing || !server)
      return yield* Effect.fail(Error('Workflow runtime unavailable'));
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'NODE_ENV'].flatMap((k) =>
        process.env[k] === undefined ? [] : [[k, process.env[k]]]
      )
    );
    for (const k of server.envKeys ?? []) {
      const v = gen.config[k];
      if (typeof v === 'string') env[k] = v;
    }
    const session = yield* Scope.fork(gen.scope);
    yield* Effect.addFinalizer((exit) =>
      Scope.close(session, exit).pipe(
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            for (const r of cause.reasons)
              if (r._tag === 'Die' && r.defect instanceof ProcessReleaseFailed)
                gen.leases.add(r.defect);
          })
        )
      )
    );
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const args = 'args' in server ? server.args : [];
    let socketPath: string | undefined;
    if ('transport' in server && server.transport === 'http') {
      if (process.platform === 'win32') socketPath = `\\\\.\\pipe\\lody-mcp-${randomUUID()}`;
      else {
        const dir = yield* Scope.provide(
          Effect.acquireRelease(
            Effect.tryPromise(() => mkdtemp(join(tmpdir(), 'mcp-'))),
            (d) => Effect.promise(() => rm(d, { force: true, recursive: true }))
          ),
          session
        );
        socketPath = join(dir, 'http');
      }
      env.LODY_MCP_SOCKET = socketPath;
    }
    yield* Effect.try(() => admit?.());
    const httpReady = socketPath ? yield* Deferred.make<void>() : undefined;
    const processHandle = yield* Scope.provide(
      spawnProcess({
        command: process.execPath,
        args: [server.entry, ...(Array.isArray(args) ? args : [])],
        options: {
          cwd: gen.rows.root,
          env,
          stdio: httpReady ? ['pipe', 'pipe', 'pipe', 'ipc'] : 'pipe',
        },
        onSpawned: httpReady
          ? (child) => {
              const acknowledge = (message: unknown) => {
                if (message === 'lody:mcp-ready') {
                  child.off('message', acknowledge);
                  Deferred.doneUnsafe(httpReady, Effect.void);
                }
              };
              child.on('message', acknowledge);
            }
          : undefined,
        processGroup: true,
      }),
      session
    );
    if (httpReady)
      yield* Effect.raceFirst(
        Deferred.await(httpReady),
        processHandle.exited.pipe(
          Effect.andThen(Effect.fail(Error('Workflow HTTP server exited before readiness')))
        )
      ).pipe(Effect.timeout('10 seconds'));
    return { processHandle, socketPath };
  });
  return {
    remove,
    install,
    provider: (id: string, agent: string) => {
      const gen = generations.get(id.split(':')[1] ?? '');
      if (!gen || gen.closing || gen.rows.acpProviders.get(id)?.managedAgent !== agent)
        throw Error('Workflow provider unavailable');
      return (
        spawn: () => Promise<import('../../session/session-sandbox').SessionProcessHandle>
      ) => {
        if (gen.closing) throw Error('Workflow provider generation withdrawn');
        const child = spawn();
        const release = async () => {
          const h = await child.catch(() => undefined);
          await h?.terminate(false);
          gen.managed.delete(release);
        };
        gen.managed.add(release);
        return child.then(
          (h) => {
            h.onClose(() => gen.managed.delete(release));
            return h;
          },
          (error) => {
            gen.managed.delete(release);
            throw error;
          }
        );
      };
    },
    catalog: () => [...generations.values()].filter((g) => !g.closing).map((g) => g.rows),
    start,
  };
});

export function workflowAgentRoles(
  rows: readonly WorkflowContributions[],
  machineId: import('@lody/shared').MachineId,
  userId: string,
  configs: readonly import('@lody/shared').AgentConfigMeta[]
): import('@lody/shared').AgentRole[] {
  return rows.flatMap((g) =>
    [...g.roles.values()].flatMap((r) => {
      const provider = r.defaultProvider;
      const config = provider?.startsWith('plugin:')
        ? provider
        : configs.find((c) => c.machineId === machineId && (!provider || c.id === provider))?.id;
      if (!config) return [];
      return [
        {
          v: 1 as const,
          id: r.id as import('@lody/shared').AgentRoleId,
          ownerUserId: userId,
          visibility: 'workspace' as const,
          name: r.name,
          description: r.description,
          emoji: r.emoji,
          machineId,
          agentConfigId: config as import('@lody/shared').AgentConfigId,
          runConfig: {},
          promptPrefix: [r.prompt, ...r.skills.map((s) => g.skills.get(s)!.markdown)].join('\n\n'),
          revision: 1,
          createdAt: 0,
          updatedAt: 0,
        },
      ];
    })
  );
}
