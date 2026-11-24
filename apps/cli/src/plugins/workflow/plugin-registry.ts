import { bindHostInvocation } from './daemon-command-executor';
import type { DispatchMachineHostCall } from '../machine-host-port';
import { packClientBundle, PLUGIN_BUNDLE_CHUNK_BYTES } from '@lody/shared/plugins/digest';
import {
  workflowApprovalReceipt,
  type WorkflowApprovalReceipt,
  pluginInspectionSchema,
  type PluginMachineRequest,
  type PluginMachineResult,
} from '@lody/shared/plugins/machine-rpc';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { Layer, Effect, Stream, Fiber, Context, Deferred, Semaphore, Cause } from 'effect';
import { pluginManifestSchema, pluginIdSchema } from '@lody/shared/plugins/manifest-schema';
import { makePluginWorkflowHarness, readWorkflowContributions } from './plugin-workflow-harness';
import { PluginHost } from './plugin-host';
import { DevPluginCompiler, watchPluginSources } from './dev-plugin-compiler';
import { machineConfig, MissingPluginConfiguration, valueFor } from '../plugin-machine-config';
const build = z.object({
  manifest: pluginManifestSchema,
  directory: z.string(),
  machineEntry: z.string().optional(),
  machineDigest: z.string().optional(),
  clientDigest: z.string().optional(),
});
const installation = z.object({
  current: build,
  previous: build.optional(),
  source: z.string(),
  dev: z.boolean(),
  enabled: z.boolean(),
  workflowReceipt: workflowApprovalReceipt.optional(),
  workflowProjectId: z.string().min(1).optional(),
  pendingConfiguration: z.boolean().optional(),
  preferences: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
const request = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('link'),
    path: z.string().min(1),
    dev: z.boolean().default(false),
  }),
  z.strictObject({ action: z.literal('list') }),
  z.strictObject({
    action: z.enum(['disable', 'reload', 'rollback', 'logs', 'inspect']),
    pluginId: pluginIdSchema,
  }),
  z.strictObject({
    action: z.enum(['enable', 'configure-many']),
    pluginId: pluginIdSchema,
    changes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  }),
  z.strictObject({
    action: z.literal('configure'),
    pluginId: pluginIdSchema,
    key: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
]);
type Item = z.infer<typeof installation>;
type Request = z.infer<typeof request>;
const io = <T>(fn: () => Promise<T>) => Effect.tryPromise({ try: fn, catch: (e) => e });
export interface VerifiedPluginGrant {
  targetDevice?: string;
  workflowReceipt?: WorkflowApprovalReceipt;
  workflowCurrent?: () => boolean;
  executeHostCall?: DispatchMachineHostCall;
  createSession?: () => Promise<Extract<PluginMachineResult, { type: 'plugin/session-create' }>>;
  userId: string;
  machineOwner: boolean;
  projectId?: string;
  sessionId?: string;
}
export class Registry extends Context.Service<
  Registry,
  {
    workflowLease: (
      id: string,
      instance: number
    ) =>
      | {
          receipt: WorkflowApprovalReceipt;
          installationId: string;
          machineDigest: string;
          isCurrent: () => boolean;
        }
      | undefined;
    workflow: Effect.Success<ReturnType<typeof makePluginWorkflowHarness>>;
    start: Effect.Effect<void, unknown>;
    machineRpc: (
      request: PluginMachineRequest,
      actor: VerifiedPluginGrant
    ) => Effect.Effect<PluginMachineResult, unknown>;
    dispatch: (raw: unknown) => Effect.Effect<Record<string, unknown>, unknown>;
  }
>()('lody/plugins/Registry') {}
export function registryLayer(
  root: string,
  workspaceId: string,
  machineId: string,
  warn: (m: string) => void,
  vault?: import('../plugin-machine-config').MachineConfigVault
) {
  return Layer.effect(
    Registry,
    Effect.gen(function* () {
      const host = yield* PluginHost,
        compiler = yield* DevPluginCompiler,
        scope = yield* Effect.scope;
      const workflow = yield* makePluginWorkflowHarness();
      const disable = (id: string) => workflow.remove(id).pipe(Effect.andThen(host.disable(id)));
      const generations = join(root, 'generations'),
        catalog = join(root, 'catalog.json');
      const items = new Map<string, Item>(),
        sessions = new Map<string, string>(),
        diagnostics = new Map<string, string>();
      const watches = new Map<string, Fiber.Fiber<void, unknown>>(),
        turns = new Map<string, Deferred.Deferred<void>>();
      const reloads = new Map<string, Deferred.Deferred<Record<string, unknown>, unknown>>();
      const catalogLock = yield* Semaphore.make(1);
      const serialize = <T, E>(id: string, work: Effect.Effect<T, E>) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const next = yield* Deferred.make<void>(),
              prev = turns.get(id);
            turns.set(id, next);
            return yield* Effect.gen(function* () {
              if (prev) yield* Deferred.await(prev);
              return yield* work;
            }).pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  if (turns.get(id) === next) turns.delete(id);
                  yield* Deferred.succeed(next, undefined);
                })
              )
            );
          })
        );
      const commit = (id: string, item: Item, admit?: () => void) =>
        catalogLock.withPermits(1)(
          io(async () => {
            const next = new Map(items);
            next.set(id, item);
            const tmp = join(root, randomUUID());
            await mkdir(root, { recursive: true, mode: 0o700 });
            try {
              await writeFile(tmp, JSON.stringify([...next.values()]), { mode: 0o600, flag: 'wx' });
              admit?.();
              await rename(tmp, catalog);
            } finally {
              await rm(tmp, { force: true });
            }
            items.set(id, item);
          }).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                diagnostics.set(id, 'Catalog persistence failed');
                warn(`Plugin ${id} catalog persistence failed`);
              })
            )
          )
        );
      const clean = (directory: string | undefined) =>
        io(async () => {
          if (
            !directory ||
            !/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(basename(directory)) ||
            dirname(directory) !== generations
          )
            return;
          if (
            ![...items.values()].some(
              (i) => i.current.directory === directory || i.previous?.directory === directory
            )
          )
            await rm(directory, { recursive: true, force: true });
        }).pipe(Effect.catch(() => Effect.sync(() => warn('Plugin generation cleanup failed'))));
      const launch = Effect.fnUntraced(function* (item: Item) {
        const b = item.current,
          pluginId = b.manifest.id,
          dataDir = join(root, 'data', pluginId);
        for (const [key, field] of Object.entries(b.manifest.config ?? {})) {
          if (
            field.scope === 'client' &&
            field.required &&
            field.default === undefined &&
            !Object.hasOwn(item.preferences ?? {}, key)
          )
            return yield* Effect.fail(
              new MissingPluginConfiguration(`Missing required configuration: ${key}`)
            );
        }
        const config = yield* io(() =>
          machineConfig(b.manifest, workspaceId, machineId, vault).resolve(item.preferences)
        );
        yield* io(() => mkdir(dataDir, { recursive: true, mode: 0o700 }));
        const rows = yield* io(() => readWorkflowContributions(b.directory, b.manifest));
        let staged = false;
        yield* host
          .reload({
            ...b,
            installationId: basename(b.directory),
            pluginId,
            dataDir,
            workspaceId,
            machineId,
            config,
            beforeStart: workflow.install(pluginId, rows, config).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  staged = true;
                })
              )
            ),
          })
          .pipe(
            Effect.onError(() =>
              staged ? workflow.remove(pluginId).pipe(Effect.orDie) : Effect.void
            )
          );
      });
      const unwatch = Effect.fnUntraced(function* (id: string) {
        const w = watches.get(id);
        watches.delete(id);
        if (w) yield* Effect.forkIn(Fiber.interrupt(w), scope);
      });
      const build = (source: string) => compiler.build(source, generations);
      function watch(id: string, item: Item): Effect.Effect<void> {
        return Effect.gen(function* () {
          if (!item.enabled || !item.dev || item.pendingConfiguration) return;
          let fiber: Fiber.Fiber<void, unknown>;
          const stream = watchPluginSources(item.source).pipe(
            Stream.runForEach(() =>
              serialize(
                id,
                Effect.suspend(() =>
                  watches.get(id) === fiber
                    ? change({ action: 'reload', pluginId: id }, id, undefined, true)
                    : Effect.void
                )
              ).pipe(
                Effect.catchCause(() => Effect.sync(() => warn(`Plugin ${id} rebuild failed`)))
              )
            ),
            Effect.catch(() => Effect.sync(() => warn(`Plugin ${id} watch ended`)))
          );
          fiber = yield* Effect.forkIn(stream, scope);
          watches.set(id, fiber);
        });
      }
      function change(
        r: Exclude<Request, { action: 'list' }>,
        id: string,
        built?: Item['current'],
        watched = false
      ): Effect.Effect<Record<string, unknown>, unknown> {
        return Effect.gen(function* () {
          const old = items.get(id);
          if (!old && r.action !== 'link')
            return yield* Effect.fail(new Error('Plugin not installed'));
          if (r.action === 'inspect') {
            const item = old!,
              manifest = item.current.manifest;
            const status = host.inspect(id);
            const preferences = Object.fromEntries(
              Object.entries(item.preferences ?? {}).filter(([k]) => {
                const f = manifest.config?.[k];
                return f && f.type !== 'secret' && f.scope !== 'machine';
              })
            );
            return {
              ...status,
              lifecycle: !item.enabled
                ? 'Disabled'
                : item.pendingConfiguration
                  ? 'PendingConfiguration'
                  : status.lifecycle,
              manifest,
              clientDigest: item.current.clientDigest,
              preferences,
              configured: yield* io(() =>
                machineConfig(manifest, workspaceId, machineId, vault).configured(preferences)
              ),
              logs: (yield* host.logs(id)).slice(-500),
              diagnostics: diagnostics.has(id) ? [diagnostics.get(id)!] : [],
            };
          }
          if (r.action === 'logs')
            return {
              logs: [
                ...(yield* host.logs(id)),
                ...(diagnostics.has(id) ? [diagnostics.get(id)!] : []),
              ],
            };
          let item: Item;
          if (r.action === 'disable') {
            yield* disable(id);
            item = {
              ...old!,
              workflowReceipt: undefined,
              workflowProjectId: undefined,
              enabled: false,
              pendingConfiguration: false,
            };
          } else if (
            r.action === 'configure' ||
            r.action === 'configure-many' ||
            r.action === 'enable'
          ) {
            item = { ...old!, enabled: r.action === 'enable' || old!.enabled };
            const manifest = item.current.manifest;
            const updates =
              r.action === 'configure' ? [[r.key, r.value] as const] : Object.entries(r.changes);
            const validated = yield* Effect.try(() =>
              updates.map(([key, value]) => {
                const field = Object.entries(manifest.config ?? {}).find(([k]) => k === key)?.[1];
                if (!field) throw new Error('Unknown config field');
                return { key, field, value: valueFor(field, value) };
              })
            );
            for (const { key, field, value } of validated) {
              if (field.type === 'secret' || field.scope === 'machine')
                yield* io(() =>
                  machineConfig(manifest, workspaceId, machineId, vault).set(key, value)
                );
              else item.preferences = { ...item.preferences, [key]: value };
            }
            if (!item.enabled || (r.action === 'configure' && !item.pendingConfiguration)) {
              yield* commit(id, item);
              return { pluginId: id };
            }
          } else {
            const current =
              r.action === 'rollback' ? old?.previous : (built ?? (yield* build(old!.source)));
            if (!current || current.manifest.id !== id) {
              yield* clean(current?.directory);
              return yield* Effect.fail(new Error('No matching plugin generation'));
            }
            item = {
              current,
              previous: old?.current,
              enabled: true,
              source: r.action === 'link' ? resolve(r.path) : old!.source,
              dev: r.action === 'link' ? r.dev : old!.dev,
              preferences: Object.fromEntries(
                Object.entries(old?.preferences ?? {}).filter(([k]) => {
                  const field = current.manifest.config?.[k];
                  return field && field.type !== 'secret' && field.scope !== 'machine';
                })
              ),
            };
          }
          const restoreCommitted = Effect.gen(function* () {
            if (old?.enabled && !old.pendingConfiguration) yield* launch(old);
            else yield* disable(id);
            yield* clean(item.current.directory);
          }).pipe(
            Effect.catchCause(() =>
              Effect.sync(() => warn(`Plugin ${id} runtime restoration failed`))
            )
          );
          if (item.enabled) {
            yield* launch(item).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  item.pendingConfiguration = false;
                })
              ),
              Effect.catch((e) => {
                if (e instanceof MissingPluginConfiguration) {
                  item.pendingConfiguration = true;
                  return old?.enabled && !old.pendingConfiguration ? disable(id) : Effect.void;
                }
                diagnostics.set(id, 'Generation failed to start');
                if (!old)
                  return commit(id, { ...item, enabled: false }).pipe(
                    Effect.andThen(Effect.fail(e))
                  );
                return restoreCommitted.pipe(Effect.andThen(Effect.fail(e)));
              })
            );
          }
          yield* commit(id, item).pipe(Effect.tapError(() => restoreCommitted));
          diagnostics.delete(id);
          if (
            item.pendingConfiguration ||
            !item.enabled ||
            (!watched && (!watches.has(id) || r.action === 'link'))
          ) {
            yield* unwatch(id);
            yield* watch(id, item);
          }
          if (!item.enabled || !item.dev || item.pendingConfiguration) sessions.delete(id);
          else if (r.action === 'link' || !sessions.has(id))
            sessions.set(id, randomBytes(16).toString('hex'));
          yield* clean(old?.previous?.directory);
          return {
            pluginId: id,
            enabled: item.enabled,
            pendingConfiguration: item.pendingConfiguration,
            clientDigest: item.current.clientDigest,
          };
        });
      }
      const start = Effect.gen(function* () {
        const raw = yield* io(() => readFile(catalog, 'utf8')).pipe(
          Effect.catch((e) =>
            (e as NodeJS.ErrnoException).code === 'ENOENT' ? Effect.succeed('[]') : Effect.fail(e)
          )
        );
        for (const item of installation.array().parse(JSON.parse(raw))) {
          if (
            vault &&
            [item.current, item.previous].some(
              (g) =>
                g &&
                (dirname(g.directory) !== generations ||
                  !/^[a-f0-9-]{36}$/.test(basename(g.directory)) ||
                  (g.machineEntry !== undefined &&
                    (!g.manifest.machine ||
                      g.machineEntry !== join(g.directory, g.manifest.machine))))
            )
          )
            return yield* Effect.fail(new Error('Plugin generation outside identity custody'));
          items.set(item.current.manifest.id, item);
        }
        for (const entry of yield* io(() => readdir(generations)).pipe(
          Effect.catch(() => Effect.succeed([] as string[]))
        ))
          if (/^\.stage-[a-zA-Z0-9]{6}$/.test(entry))
            yield* io(() => rm(join(generations, entry), { recursive: true, force: true })).pipe(
              Effect.catch(() => Effect.sync(() => warn('Plugin stage cleanup failed')))
            );
          else yield* clean(join(generations, entry));
        yield* Effect.forEach(
          items,
          ([id, item]) =>
            serialize(
              id,
              Effect.gen(function* () {
                if (!item.enabled) return;
                yield* launch(item);
                item.pendingConfiguration = false;
                if (item.dev) sessions.set(id, randomBytes(16).toString('hex'));
                yield* watch(id, item);
              })
            ).pipe(
              Effect.catchCause((c) =>
                Effect.sync(() => {
                  if (Cause.squash(c) instanceof MissingPluginConfiguration)
                    item.pendingConfiguration = true;
                  diagnostics.set(id, 'Generation failed to start');
                  warn(`Plugin ${id} failed to start`);
                })
              )
            ),
          { concurrency: 'unbounded', discard: true }
        );
      });
      return Registry.of({
        workflowLease: (id, instance) => {
          const item = items.get(id);
          if (
            !item?.enabled ||
            !item.workflowReceipt ||
            !item.workflowProjectId ||
            !item.current.machineDigest
          )
            return undefined;
          const live = () => {
            const running = host.inspect(id);
            return (
              items.get(id) === item &&
              running.instanceId === instance &&
              running.machineDigest === item.current.machineDigest &&
              running.installationId === basename(item.current.directory)
            );
          };
          return live()
            ? {
                receipt: item.workflowReceipt,
                installationId: basename(item.current.directory),
                machineDigest: item.current.machineDigest,
                isCurrent: live,
              }
            : undefined;
        },
        workflow,
        start,
        machineRpc: Effect.fnUntraced(function* (r, actor): Effect.fn.Return<
          PluginMachineResult,
          unknown
        > {
          if (!actor.userId || r.workspaceId !== workspaceId || r.machineId !== machineId)
            return yield* Effect.fail(new Error('Invalid plugin target'));
          if (r.method === 'plugin/catalog') {
            const installations = [];
            for (const [id, item] of items) {
              const inspection = actor.machineOwner
                ? yield* change({ action: 'inspect', pluginId: id }, id).pipe(
                    Effect.map((value) => pluginInspectionSchema.parse(value)),
                    Effect.catch(() => Effect.succeed(undefined))
                  )
                : undefined;
              const contributions = actor.machineOwner
                ? workflow.catalog().find((g) => g.pluginId === id)
                : undefined;
              installations.push({
                workflowPrompts: contributions
                  ? Object.fromEntries(
                      [...contributions.roles.values()].map((role) => [
                        role.id.split(':')[2]!,
                        [
                          role.prompt,
                          ...role.skills.map((s) => contributions.skills.get(s)!.markdown),
                        ].join('\n\n'),
                      ])
                    )
                  : undefined,
                workflowInstallation:
                  actor.machineOwner && actor.targetDevice && item.current.machineDigest
                    ? {
                        installationId: basename(item.current.directory),
                        machineDigest: item.current.machineDigest,
                        targetDevice: actor.targetDevice,
                      }
                    : undefined,
                manifest: item.current.manifest,
                enabled: item.enabled && !item.pendingConfiguration,
                clientDigest: item.current.clientDigest,
                devSessionNonce: actor.machineOwner ? sessions.get(id) : undefined,
                inspection,
              });
            }
            return { type: r.method, installations };
          }
          const id = r.params.pluginId;
          const item = items.get(id);
          if (!item) return yield* Effect.fail(new Error('Plugin unavailable'));
          if (r.method === 'plugin/workflow-create-approval')
            return yield* serialize(
              id,
              Effect.gen(function* () {
                const current = items.get(id),
                  a = r.params;
                if (
                  !actor.machineOwner ||
                  !actor.workflowReceipt ||
                  !actor.workflowCurrent?.() ||
                  !current?.enabled ||
                  current.pendingConfiguration ||
                  basename(current.current.directory) !== a.installationId ||
                  current.current.machineDigest !== a.machineDigest ||
                  actor.targetDevice !== a.targetDevice
                )
                  throw Error('Workflow approval forbidden');
                if (a.action === 'revoke' && current.workflowProjectId !== a.projectId)
                  return { type: r.method, active: false };
                yield* commit(
                  id,
                  {
                    ...current,
                    workflowReceipt: a.action === 'grant' ? actor.workflowReceipt : undefined,
                    workflowProjectId: a.action === 'grant' ? a.projectId : undefined,
                  },
                  () => {
                    if (
                      !actor.workflowCurrent?.() ||
                      (a.action === 'grant' && Date.now() >= a.expiresAt)
                    )
                      throw Error('Workflow approval withdrawn');
                  }
                );
                return { type: r.method, active: a.action === 'grant' };
              })
            );
          if (r.method === 'plugin/control') {
            if (!actor.machineOwner) return yield* Effect.fail(new Error('Owner required'));
            const t = r.params;
            return yield* serialize(
              id,
              Effect.gen(function* () {
                if (items.get(id)?.current.clientDigest !== t.clientDigest)
                  return yield* Effect.fail(new Error('Plugin generation changed'));
                if (t.action !== 'inspect') {
                  const cmd =
                    t.action === 'enable' || t.action === 'configure-many'
                      ? { action: t.action, pluginId: id, changes: t.changes ?? {} }
                      : { action: t.action, pluginId: id };
                  yield* change(cmd, id);
                }
                return {
                  type: 'plugin/control' as const,
                  inspection: pluginInspectionSchema.parse(
                    yield* change({ action: 'inspect', pluginId: id }, id)
                  ),
                };
              })
            );
          }
          if (!item.enabled || item.pendingConfiguration)
            return yield* Effect.fail(new Error('Plugin disabled'));
          if (r.method === 'plugin/bundle-chunk') {
            if (r.params.clientDigest !== item.current.clientDigest)
              return yield* Effect.fail(new Error('Stale bundle'));
            const bytes = yield* io(() =>
              packClientBundle(item.current.manifest, (p) =>
                readFile(join(item.current.directory, p))
              )
            );
            const offset = r.params.offset;
            if (
              !bytes ||
              createHash('sha256').update(bytes).digest('hex') !== r.params.clientDigest
            )
              return yield* Effect.fail(new Error('Stale bundle'));
            if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length)
              return yield* Effect.fail(new Error('Invalid bundle offset'));
            return {
              type: r.method,
              base64: Buffer.from(
                bytes.subarray(offset, offset + PLUGIN_BUNDLE_CHUNK_BYTES)
              ).toString('base64'),
              totalBytes: bytes.length,
            };
          }
          if (r.method === 'plugin/session-create') {
            const { scope, target, clientDigest } = r.params;
            if (
              !actor.createSession ||
              clientDigest !== item.current.clientDigest ||
              !item.current.manifest.client ||
              target.workspaceId !== workspaceId ||
              target.machineId !== machineId ||
              target.sessionId ||
              (scope === 'machine'
                ? !actor.machineOwner || target.projectId !== undefined
                : !actor.projectId || actor.projectId !== target.projectId)
            )
              return yield* Effect.fail(new Error('Plugin create forbidden'));
            return yield* io(actor.createSession);
          }
          const { descriptorId, scope, target, input } = r.params;
          if (
            target.workspaceId !== workspaceId ||
            target.machineId !== machineId ||
            (scope === 'machine' &&
              (!actor.machineOwner || target.projectId || target.sessionId)) ||
            (scope === 'project' &&
              (!actor.projectId || target.projectId !== actor.projectId || target.sessionId)) ||
            (scope === 'session' &&
              (!actor.sessionId ||
                target.sessionId !== actor.sessionId ||
                target.projectId !== actor.projectId))
          )
            return yield* Effect.fail(new Error('Plugin scope forbidden'));
          const kind =
            r.method === 'plugin/query'
              ? 'query'
              : r.method === 'plugin/mutate'
                ? 'mutation'
                : r.method === 'plugin/attachment-search'
                  ? 'attachment-search'
                  : 'attachment-resolve';
          if (!host.inspect(id).registrations.includes(`${kind}: ${descriptorId}`))
            return yield* Effect.fail(new Error('Plugin handler unavailable'));
          const boundTarget = Object.freeze({ ...target });
          const release = actor.executeHostCall
            ? bindHostInvocation(boundTarget, actor.executeHostCall)
            : () => {};
          const data = yield* host
            .invoke(id, {
              kind,
              descriptorId,
              scope,
              target: boundTarget,
              input,
              actorUserId: actor.userId,
            })
            .pipe(Effect.ensuring(Effect.sync(release)));
          return { type: r.method, data: z.json().parse(data) };
        }),
        dispatch: Effect.fnUntraced(function* (raw: unknown) {
          const r = request.parse(raw);
          if (r.action === 'list')
            return {
              plugins: [...items].map(([pluginId, i]) => ({
                pluginId,
                enabled: i.enabled,
                pendingConfiguration: i.pendingConfiguration ?? false,
                devMode: i.enabled && i.dev && !i.pendingConfiguration,
                devSessionNonce: sessions.get(pluginId),
                clientDigest: i.current.clientDigest,
              })),
            };
          const built = r.action === 'link' ? yield* build(resolve(r.path)) : undefined,
            id = r.action === 'link' ? built!.manifest.id : r.pluginId;
          if (r.action === 'reload' && items.get(id)?.dev) {
            const pending = reloads.get(id);
            if (pending) return yield* Deferred.await(pending);
            const result = yield* Deferred.make<Record<string, unknown>, unknown>();
            reloads.set(id, result);
            return yield* serialize(
              id,
              Effect.gen(function* () {
                if (reloads.get(id) === result) reloads.delete(id);
                const exit = yield* Effect.exit(change(r, id));
                yield* Deferred.done(result, exit);
                return yield* Deferred.await(result);
              })
            );
          }
          reloads.delete(id);
          return yield* serialize(id, change(r, id, built));
        }),
      });
    })
  );
}
