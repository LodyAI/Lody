import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { workspaceFlockKeys, type WorkspaceFlockReadableFlock } from '@lody/shared';
import {
  syncChallengeSchema,
  workspacePluginEntrySchema,
  type WorkspacePluginEntry,
} from '@lody/shared/plugins/workspace-entry';
type Fence = () => void;
interface Ports {
  owner: string;
  machine: string;
  signal: AbortSignal;
  flock: WorkspaceFlockReadableFlock & {
    set(key: string[], value: unknown): void;
    delete(key: string[]): void;
    commit(): void;
    subscribe(cb: () => void): () => void;
  };
  verify(pin: WorkspacePluginEntry): Promise<Fence>;
  installed(id: string): Promise<boolean>;
  install(
    pin: WorkspacePluginEntry,
    signal: AbortSignal,
    verify: () => Promise<Fence>
  ): Promise<void>;
  flush(): Promise<unknown>;
  warn(): void;
}
/** Shared rows can replay. Only this process's outstanding nonce plus a fresh owner countersignature admits installation. */
export function watchPluginOwnerDecisions(ports: Ports) {
  type Attempt = {
    signature: string;
    controller: AbortController;
    nonce: string;
    processing: boolean;
    dirty: boolean;
    done: boolean;
  };
  const pending = new Map<string, Attempt>();
  const rows = (prefix: string[]) => Array.from(ports.flock.scan({ prefix }));
  const jobs = new Set<Promise<void>>();
  let stopped = false;
  const scan = () => {
    if (stopped) return;
    const seen = new Set<string>();
    for (const { key, value } of rows(['pluginOwnerSync', ports.owner])) {
      const parsed = workspacePluginEntrySchema.safeParse(value);
      if (!parsed.success) continue;
      const pin = parsed.data,
        sig = pin.sync_signature;
      if (
        !sig ||
        !pin.sync_decision_id ||
        pin.sync_challenge ||
        pin.sync_confirmed_at ||
        pin.sync_owner_user_id !== ports.owner ||
        key.length !== 3 ||
        key[2] !== pin.plugin_id
      )
        continue;
      const id = pin.plugin_id;
      seen.add(id);
      let attempt = pending.get(id);
      if (attempt?.signature !== sig) {
        attempt?.controller.abort();
        attempt = {
          signature: sig,
          controller: new AbortController(),
          nonce: randomUUID(),
          processing: false,
          dirty: false,
          done: false,
        };
        pending.set(id, attempt);
      }
      if (attempt.done) continue;
      if (attempt.processing) {
        attempt.dirty = true;
        continue;
      }
      attempt.processing = true;
      const local = attempt;
      const signal = AbortSignal.any([local.controller.signal, ports.signal]);
      const targetKey = workspaceFlockKeys.pluginSyncChallenge(ports.owner, ports.machine, id);
      const run = async () => {
        const original = await ports.verify(pin);
        const fence = () => {
          signal.throwIfAborted();
          original();
          if (
            pending.get(id) !== local ||
            rows(['pluginOwnerSync', ports.owner, id]).every(
              (r) => !isDeepStrictEqual(r.value, pin)
            )
          )
            throw Error('Owner sync decision withdrawn');
        };
        fence();
        if (pin.machine_sync === 'manual') {
          local.done = true;
          return;
        }
        const bound = {
          owner: ports.owner,
          machine: ports.machine,
          plugin: id,
          decision: sig,
          nonce: local.nonce,
        };
        const reply = syncChallengeSchema.safeParse(rows(targetKey)[0]?.value);
        const response = reply.success ? reply.data : undefined;
        if (
          !response ||
          response.nonce !== local.nonce ||
          response.decision !== sig ||
          response.machine !== ports.machine ||
          response.owner !== ports.owner ||
          response.plugin !== id
        ) {
          if (await ports.installed(id)) {
            local.done = true;
            return;
          }
          fence();
          ports.flock.set(targetKey, bound);
          ports.flock.commit();
          await ports.flush();
          return;
        }
        if (!response.confirmation || !response.confirmedAt) return;
        const proof: WorkspacePluginEntry = {
          ...pin,
          sync_challenge: bound,
          sync_confirmed_at: response.confirmedAt,
          sync_signature: response.confirmation,
        };
        const live = await ports.verify(proof);
        const check = () => {
          fence();
          live();
          const age = Date.now() - response.confirmedAt!;
          if (age < 0 || age > 120000) throw Error('Owner confirmation expired');
        };
        if (Date.now() - response.confirmedAt > 120000) {
          local.nonce = randomUUID();
          local.dirty = true;
          return;
        }
        check();
        await ports.install(pin, signal, async () => {
          check();
          return check;
        });
        local.done = true;
        ports.flock.delete(targetKey);
        ports.flock.commit();
        await ports.flush();
      };
      const work = run()
        .catch(() => {
          if (!signal.aborted) ports.warn();
        })
        .finally(() => {
          jobs.delete(work);
          local.processing = false;
          if (local.dirty && !stopped) {
            local.dirty = false;
            scan();
          }
        });
      jobs.add(work);
    }
    for (const [id, local] of pending)
      if (!seen.has(id)) {
        local.controller.abort();
        pending.delete(id);
      }
  };
  const unsubscribe = ports.flock.subscribe(scan);
  return {
    async refresh() {
      scan();
      while (jobs.size) await Promise.all([...jobs]);
    },
    stop() {
      stopped = true;
      unsubscribe();
      for (const item of pending.values()) item.controller.abort();
      pending.clear();
    },
  };
}
