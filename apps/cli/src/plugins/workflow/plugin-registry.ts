import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { Layer, Effect, Stream, Fiber, Context, Deferred, Semaphore, Cause } from 'effect';
import { pluginManifestSchema, pluginIdSchema } from '@lody/shared/plugins/manifest-schema';
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
    action: z.enum(['disable', 'reload', 'rollback', 'logs']),
    pluginId: pluginIdSchema,
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
export class Registry extends Context.Service<
  Registry,
  {
    start: Effect.Effect<void, unknown>;
    dispatch: (raw: unknown) => Effect.Effect<Record<string, unknown>, unknown>;
  }
>()('lody/plugins/Registry') {}
export function registryLayer(
  root: string,
  workspaceId: string,
  machineId: string,
  warn: (m: string) => void
) {
  return Layer.effect(
    Registry,
    Effect.gen(function* () {
      const host = yield* PluginHost,
        compiler = yield* DevPluginCompiler,
        scope = yield* Effect.scope;
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
      const commit = (id: string, item: Item) =>
        catalogLock.withPermits(1)(
          io(async () => {
            const next = new Map(items);
            next.set(id, item);
            const tmp = join(root, randomUUID());
            await mkdir(root, { recursive: true, mode: 0o700 });
            try {
              await writeFile(tmp, JSON.stringify([...next.values()]), { mode: 0o600, flag: 'wx' });
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
        const config = yield* io(() =>
          machineConfig(b.manifest, workspaceId, machineId).resolve(item.preferences)
        );
        yield* io(() => mkdir(dataDir, { recursive: true, mode: 0o700 }));
        yield* host.reload({ ...b, pluginId, dataDir, workspaceId, machineId, config });
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
          if (r.action === 'logs')
            return {
              logs: [
                ...(yield* host.logs(id)),
                ...(diagnostics.has(id) ? [diagnostics.get(id)!] : []),
              ],
            };
          let item: Item;
          if (r.action === 'disable') {
            yield* host.disable(id);
            item = { ...old!, enabled: false, pendingConfiguration: false };
          } else if (r.action === 'configure') {
            const field = Object.entries(old!.current.manifest.config ?? {}).find(
              ([k]) => k === r.key
            )?.[1];
            if (!field) return yield* Effect.fail(new Error('Unknown config field'));
            item = { ...old! };
            if (field.type === 'secret' || field.scope === 'machine')
              yield* io(() =>
                machineConfig(item.current.manifest, workspaceId, machineId).set(r.key, r.value)
              );
            else item.preferences = { ...item.preferences, [r.key]: valueFor(field, r.value) };
            if (!item.pendingConfiguration || !item.enabled) {
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
            else yield* host.disable(id);
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
                  return old?.enabled && !old.pendingConfiguration ? host.disable(id) : Effect.void;
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
        for (const item of installation.array().parse(JSON.parse(raw)))
          items.set(item.current.manifest.id, item);
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
        start,
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
