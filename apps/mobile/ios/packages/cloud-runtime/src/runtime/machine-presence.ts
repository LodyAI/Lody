import { EphemeralStore } from 'loro-crdt/base64';
import {
  EphemeralStoreAdaptor,
  EphemeralStreamCrdt,
} from '@loro-dev/streams-crdt/loro';
import type { MachinePresence } from '../models/machines.ts';
import type { CreationOptions } from '../models/send.ts';

// Official Lody presence protocol: durable machine metadata is not liveness.
export const machinePresenceTTL = 90_000;

export function availableCreationOptions(
  options: CreationOptions,
  presence: MachinePresence,
): CreationOptions {
  const online = new Set(presence.onlineMachineIds);
  let availability: NonNullable<CreationOptions['availability']> = 'online';
  if (presence.state !== 'live') availability = 'unknown';
  else if (
    options.project?.machineId &&
    !options.project.id.startsWith('github:')
  ) {
    if (!online.has(options.project.machineId)) availability = 'offline';
  } else if (!online.size) availability = 'offline';
  return {
    ...options,
    agents: options.agents.filter(
      (agent) => presence.state === 'live' && online.has(agent.machineId),
    ),
    availability,
    onlineMachineIds: presence.state === 'live' ? [...online] : undefined,
  };
}

export function onlineMachines(
  states: Record<string, unknown>,
  now: number,
): string[] {
  const ids = new Set<string>();
  for (const value of Object.values(states)) {
    if (!value || typeof value !== 'object') continue;
    const state = value as Record<string, unknown>;
    if (
      state.kind !== 'machine' ||
      typeof state.machineId !== 'string' ||
      !state.machineId ||
      typeof state.instanceId !== 'string' ||
      !state.instanceId ||
      typeof state.updatedAt !== 'number' ||
      !Number.isFinite(state.updatedAt)
    )
      continue;
    if (now - state.updatedAt < machinePresenceTTL) ids.add(state.machineId);
  }
  return [...ids].sort();
}

type Grant = {
  token: string;
  gatewayBaseUrl: string;
  shardHostSuffix?: string;
};

export function presenceURL(grant: Grant, workspace: string) {
  const base = new URL(grant.gatewayBaseUrl);
  if (grant.shardHostSuffix && /^[a-z0-9.-]+$/i.test(grant.shardHostSuffix)) {
    base.protocol = 'https:';
    base.host = `presence.${grant.shardHostSuffix}`;
    base.port = '';
  }
  return `${base.toString().replace(/\/$/, '')}/ds/lody/${encodeURIComponent(`${workspace}:meta`)}?ephemeral=presence`;
}

export function watchMachinePresence(
  workspace: string,
  getGrant: () => Promise<Grant>,
  publish: (value: MachinePresence) => void,
) {
  let stopped = false;
  let generation = 0;
  let close = () => {};
  let retry: ReturnType<typeof setTimeout> | undefined;
  let last = '';
  const emit = (value: MachinePresence) => {
    const next = JSON.stringify(value);
    if (last === next) return;
    last = next;
    publish(value);
  };
  const unknown = () => emit({ state: 'unknown', onlineMachineIds: [] });
  const start = async () => {
    const version = ++generation;
    close();
    unknown();
    try {
      const grant = await getGrant();
      if (stopped || version !== generation) return;
      const store = new EphemeralStore(machinePresenceTTL);
      const room = new EphemeralStreamCrdt({
        streamUrl: presenceURL(grant, workspace),
        auth: async () => (await getGrant()).token,
        adaptor: EphemeralStoreAdaptor(store),
      });
      let joined = false;
      let disconnectedAt = Date.now();
      const emitSnapshot = () => {
        if (!stopped && version === generation && joined)
          emit({
            state: 'live',
            onlineMachineIds: onlineMachines(store.getAllStates(), Date.now()),
          });
      };
      const detach = store.subscribe(emitSnapshot);
      const tick = setInterval(() => {
        if (!joined && Date.now() - disconnectedAt >= 25_000) reconnect();
        else emitSnapshot();
      }, 5_000);
      close = () => {
        clearInterval(tick);
        detach();
        // Close transport before destroying its WASM store.
        void room
          .close()
          .catch(() => {})
          .finally(() => store.destroy());
      };
      const result = await room.join({
        onStatusChange: (status) => {
          if (stopped || version !== generation) return;
          if (joined && status !== 'joined') disconnectedAt = Date.now();
          joined = status === 'joined';
          if (joined) {
            emitSnapshot();
          } else {
            unknown();
            if (status === 'error' || status === 'disconnected') reconnect();
          }
        },
      });
      if (!result.ok && version === generation) reconnect();
    } catch {
      if (version === generation) reconnect();
    }
  };
  function reconnect() {
    if (stopped || retry) return;
    ++generation;
    close();
    close = () => {};
    unknown();
    retry = setTimeout(() => {
      retry = undefined;
      void start();
    }, 3_000);
  }
  void start();
  return () => {
    stopped = true;
    ++generation;
    clearTimeout(retry);
    close();
    unknown();
  };
}
