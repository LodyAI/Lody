import { loroEphemeralUpdateKey } from '@loro-dev/streams-crdt/loro';
import { z } from 'zod';
import { EphemeralStore } from 'loro-crdt';
import {
  parseEncryptedPresencePublication,
  ENCRYPTED_PRESENCE_MAX_BYTES,
  ENCRYPTED_PRESENCE_TTL_MS,
  type EncryptedPresenceEntry,
  type EncryptedPresencePort,
} from './encrypted-presence';
import { getServerNow } from './time-sync';
import type { LodyPresenceState } from './presence';

const MAX_FRAME_BYTES = ENCRYPTED_PRESENCE_MAX_BYTES + 41 + 143;
const MAX_RECEIVED_KEYS = 4096;
const opaqueKey = /^[0-9a-f]{32}$/;

/** @deprecated Promise SDK boundary shared by native CLI transport and renderer.
 * The real server materializes a Loro EphemeralStore: its opaque keys carry only
 * signed ciphertext values. Crypto work is coalesced at four publications/second,
 * with 128 pending keys; the SDK remains the sole POST/SSE queue. Close fences
 * callbacks and joins raw crypto before destroying its wire store.
 */
export function createEncryptedPresenceAdaptorLegacy(
  store: EphemeralStore,
  port: EncryptedPresencePort,
  options: {
    initialAvailable?: boolean;
    onAvailabilityChange?: (available: boolean) => void;
    /** Owner-retained authenticated receipts, for store-replacing reconnects. */
    retained?: Map<string, EncryptedPresenceEntry>;
  } = {}
) {
  let active = true;
  let available = options.initialAvailable ?? true;
  let applying = false;
  let revision = 0;
  let overflow = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<void> | undefined;
  let closeReceipt: Promise<void> | undefined;
  let detach: (() => void) | undefined;
  const wire = new EphemeralStore(ENCRYPTED_PRESENCE_TTL_MS);
  const transportKeys = new Map<string, { id: string; expiresAt: number }>();
  const remote = new Map<string, number>();
  const unavailable = new Map<string, Uint8Array>();
  const pending = new Map<string, { key: string; state: LodyPresenceState | null }>();
  const incoming = new Set<Promise<void>>();
  const reportAvailability = (next: boolean) => {
    if (!active || available === next) return;
    available = next;
    try {
      options.onAvailabilityChange?.(next);
    } catch {
      /* Observational only. */
    }
  };
  const removeRemote = (all: boolean) => {
    applying = true;
    try {
      const now = getServerNow();
      for (const [key, expiry] of remote)
        if (all || !Number.isFinite(now) || now >= expiry) {
          remote.delete(key);
          options.retained?.delete(key);
          store.delete(key);
        }
      if (all) options.retained?.clear();
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
  // Rehydrate receipts, not network replays. Tombstones and verified invalidation
  // remove receipts before a replacement store can adopt them.
  for (const [key, entry] of options.retained ?? []) {
    if (!entry.state || entry.expiresAt <= getServerNow()) {
      options.retained?.delete(key);
      continue;
    }
    remote.set(key, entry.expiresAt);
    store.set(key, z.json().parse({ ...entry.state, expiresAt: entry.expiresAt }));
  }
  scheduleExpiry();

  const receive = (frames: Iterable<readonly [string, Uint8Array]>) => {
    const task = (async () => {
      let authenticated = false;
      for (const [id, frame] of frames) {
        if (!active) return;
        const captured = revision;
        try {
          const entry = await port.open(frame);
          if (!active || captured !== revision) continue;
          if (entry && 'unavailable' in entry) {
            if (unavailable.has(id) || unavailable.size < MAX_RECEIVED_KEYS)
              unavailable.set(id, frame);
            else overflow = true;
            reportAvailability(false);
            continue;
          }
          if (!entry) continue;
          unavailable.delete(id);
          authenticated = true;
          if (!Number.isSafeInteger(entry.expiresAt) || getServerNow() >= entry.expiresAt) continue;
          applying = true;
          try {
            if (entry.state) {
              remote.set(entry.key, entry.expiresAt);
              options.retained?.set(entry.key, entry);
              store.set(entry.key, z.json().parse({ ...entry.state, expiresAt: entry.expiresAt }));
            } else {
              remote.delete(entry.key);
              options.retained?.delete(entry.key);
              store.delete(entry.key);
            }
            scheduleExpiry();
          } finally {
            applying = false;
          }
        } catch {
          // A rejected host call is a local capability failure. Malformed remote
          // content returns null at the authenticated host boundary instead.
          if (!active || captured !== revision) continue;
          if (unavailable.has(id) || unavailable.size < MAX_RECEIVED_KEYS)
            unavailable.set(id, frame);
          else overflow = true;
          reportAvailability(false);
        }
      }
      if (authenticated && unavailable.size === 0 && !overflow) reportAvailability(true);
    })();
    incoming.add(task);
    void task.finally(() => incoming.delete(task));
    return task;
  };
  const detachInvalidation = port.subscribeInvalidation?.((reason) => {
    if (!active) return;
    if (reason !== 'keys') {
      revision++;
      removeRemote(true);
      clearTimeout(expiryTimer);
    }
    if (unavailable.size > 0) void receive([...unavailable]);
  });
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
          if (!active || frame.byteLength > MAX_FRAME_BYTES) return;
          const now = getServerNow();
          for (const [logical, identity] of transportKeys)
            if (identity.expiresAt <= now) transportKeys.delete(logical);
          let identity = transportKeys.get(key);
          if (!identity) {
            if (transportKeys.size >= MAX_RECEIVED_KEYS) return;
            identity = {
              id: crypto.randomUUID().replaceAll('-', ''),
              expiresAt: now + ENCRYPTED_PRESENCE_TTL_MS,
            };
            transportKeys.set(key, identity);
          }
          identity.expiresAt = now + ENCRYPTED_PRESENCE_TTL_MS;
          // Even logical deletion is a signed encrypted value, never an
          // unauthenticated outer tombstone that could clear another author.
          wire.set(identity.id, frame);
          listener(wire.encode(identity.id));
        } catch {
          /* Retry disposable publication at a later heartbeat/transition. */
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
    isAvailable: () => available,
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
            /* Never publish an unbounded/non-liveness field. */
          }
        });
        return () => {
          detach?.();
          detach = undefined;
        };
      },
      localUpdateKey: loroEphemeralUpdateKey,
      applyRemoteUpdates(updates: readonly Uint8Array[]) {
        const frames = new Map<string, Uint8Array>();
        for (const update of updates) {
          if (!active) break;
          if (update.byteLength > MAX_RECEIVED_KEYS * (MAX_FRAME_BYTES + 128)) continue;
          const envelope = new EphemeralStore(ENCRYPTED_PRESENCE_TTL_MS);
          try {
            envelope.apply(update);
            for (const [id, value] of Object.entries(envelope.getAllStates())) {
              if (frames.size >= MAX_RECEIVED_KEYS) break;
              if (
                opaqueKey.test(id) &&
                value instanceof Uint8Array &&
                value.byteLength <= MAX_FRAME_BYTES
              )
                frames.set(id, value);
            }
          } catch {
            /* Bad outer Loro bytes are remote input, not local crypto failure. */
          } finally {
            envelope.destroy();
          }
        }
        return receive(frames);
      },
    },
    close() {
      retire();
      return (closeReceipt ??= (async () => {
        await Promise.allSettled([...(sending ? [sending] : []), ...incoming]);
        wire.destroy();
        transportKeys.clear();
        unavailable.clear();
      })());
    },
  };
}
