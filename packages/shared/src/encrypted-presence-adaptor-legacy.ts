import { loroEphemeralUpdateKey } from '@loro-dev/streams-crdt/loro';
import { z } from 'zod';
import type { EphemeralStore } from 'loro-crdt';
import {
  parseEncryptedPresencePublication,
  ENCRYPTED_PRESENCE_MAX_BYTES,
  type EncryptedPresencePort,
} from './encrypted-presence';
import { getServerNow } from './time-sync';
import type { LodyPresenceState } from './presence';

/** @deprecated Promise SDK boundary shared by native CLI transport and renderer.
 * Coalesces only pending crypto work, at most four small publications/second and
 * 128 distinct keys. The SDK remains the sole POST/SSE queue. Close fences callbacks
 * synchronously and joins raw crypto; failures never enter document sync.
 */
export function createEncryptedPresenceAdaptorLegacy(
  store: EphemeralStore,
  port: EncryptedPresencePort
) {
  let active = true;
  let applying = false;
  let revision = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const remote = new Map<string, number>();
  const removeRemote = (all: boolean) => {
    applying = true;
    try {
      const now = getServerNow();
      for (const [key, expiry] of remote)
        if (all || !Number.isFinite(now) || now >= expiry) {
          remote.delete(key);
          store.delete(key);
        }
    } finally {
      applying = false;
    }
  };
  const scheduleExpiry = () => {
    clearTimeout(expiryTimer);
    if (!active || remote.size === 0) return;
    expiryTimer = setTimeout(
      () => {
        removeRemote(false);
        scheduleExpiry();
      },
      Math.max(1, Math.min(...remote.values()) - getServerNow())
    );
  };
  const detachInvalidation = port.subscribeInvalidation?.(() => {
    if (!active) return;
    revision++;
    removeRemote(true);
    clearTimeout(expiryTimer);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<void> | undefined;
  const pending = new Map<string, { key: string; state: LodyPresenceState | null }>();
  const incoming = new Set<Promise<void>>();
  const updateKeys = new WeakMap<Uint8Array, string>();
  let detach: (() => void) | undefined;
  const schedule = (listener: (update: Uint8Array) => void) => {
    if (!active || timer || sending || pending.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      const item =
        [...pending.entries()].find(([key]) => key.startsWith('machine:')) ??
        pending.entries().next().value;
      if (!item || !active) return;
      const [key, publication] = item;
      pending.delete(key);
      sending = (async () => {
        try {
          const frame = await port.seal(publication);
          if (active) {
            updateKeys.set(frame, key);
            listener(frame);
          }
        } catch {
          /* Disposable liveness: retry at the next heartbeat/transition. */
        }
      })().finally(() => {
        sending = undefined;
        schedule(listener);
      });
    }, 250);
  };
  const retire = () => {
    active = false;
    clearTimeout(timer);
    clearTimeout(expiryTimer);
    detachInvalidation?.();
    pending.clear();
    detach?.();
  };
  return {
    retire,
    adaptor: {
      subscribeLocalUpdates(listener: (update: Uint8Array) => void) {
        detach = store.subscribeLocalUpdates((update) => {
          if (!active || applying) return;
          const key = loroEphemeralUpdateKey(update);
          if (key === undefined || key.length === 0) return;
          if (!pending.has(key) && pending.size >= 128) {
            if (!key.startsWith('machine:')) return;
            const oldest = pending.keys().next().value;
            if (oldest !== undefined) pending.delete(oldest);
          }
          try {
            const publication = parseEncryptedPresencePublication({
              key,
              state: store.get(key) ?? null,
            });
            if (
              new TextEncoder().encode(JSON.stringify(publication)).byteLength <=
              ENCRYPTED_PRESENCE_MAX_BYTES
            )
              pending.set(key, publication);
            schedule(listener);
          } catch {
            /* Never publish an unbounded or non-liveness field. */
          }
        });
        return () => {
          detach?.();
          detach = undefined;
        };
      },
      localUpdateKey: (update: Uint8Array) => updateKeys.get(update),
      applyRemoteUpdates(updates: readonly Uint8Array[]) {
        const task = (async () => {
          for (const frame of updates) {
            if (!active) return;
            try {
              const captured = revision;
              const entry = await port.open(frame);
              if (
                !active ||
                captured !== revision ||
                !entry ||
                !Number.isSafeInteger(entry.expiresAt) ||
                getServerNow() >= entry.expiresAt
              )
                continue;
              applying = true;
              try {
                if (entry.state) {
                  remote.set(entry.key, entry.expiresAt);
                  store.set(
                    entry.key,
                    z.json().parse({
                      ...entry.state,
                      expiresAt: entry.expiresAt,
                    })
                  );
                } else {
                  remote.delete(entry.key);
                  store.delete(entry.key);
                }
                scheduleExpiry();
              } finally {
                applying = false;
              }
            } catch {
              /* Bad peers and unavailable crypto affect presence only. */
            }
          }
        })();
        incoming.add(task);
        void task.finally(() => incoming.delete(task));
        return task;
      },
    },
    async close() {
      retire();
      await Promise.allSettled([...(sending ? [sending] : []), ...incoming]);
    },
  };
}
