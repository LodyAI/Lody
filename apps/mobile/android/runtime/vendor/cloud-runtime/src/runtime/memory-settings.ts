import { Flock } from '@loro-dev/flock-wasm/base64';
import type {
  MemoryRequest,
  MemorySnapshot,
  MemoryStatus,
} from '../models/memory';
import type { MachinePresence } from '../models/machines';
import { machineState } from '../models/machines';
import { memoryAssociation, memoryInventory } from '../protocol/memory';
import { encodeFrame } from '../frames';
import { openSettings, settingsRows } from './settings';
import { machineRpc } from './machine-rpc';
import { clientFor } from './session';

const providerId = 'nowledge-mem';
export function memoryRows(flock: Flock, machineId: string) {
  return [...flock.scan()]
    .flatMap(({ key, value }) => {
      const parsed = memoryAssociation.safeParse(value);
      if (
        key.length !== 3 ||
        key[0] !== 'memory' ||
        !parsed.success ||
        parsed.data.machineId !== machineId ||
        parsed.data.providerId !== key[1] ||
        parsed.data.memoryId !== key[2]
      )
        return [];
      return [parsed.data];
    })
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.memoryId.localeCompare(b.memoryId),
    );
}

export async function memorySettings(
  request: MemoryRequest,
  userId: string,
  meta: Flock,
  replicas: Map<string, Flock>,
  presence: () => MachinePresence,
  grant: Parameters<typeof openSettings>[1],
  signal: AbortSignal,
  checkScope: () => void,
): Promise<MemorySnapshot> {
  checkScope();
  if (!userId || !['list', 'import', 'remove'].includes(request.action))
    throw new Error('memory_invalid');
  const field = (id: string, name: string) =>
    meta.get(['m', `machine-${id}`, name]) ??
    (meta.get(['m', `machine-${id}`]) as Record<string, unknown> | undefined)?.[
      name
    ];
  // shortcut: Own machines only until iOS implements Cloud listVisibleMachines authorization.
  const machines = settingsRows('machine', meta)
    .filter((m) => field(m.id, 'ownerUserId') === userId)
    .map(({ id, name }) => ({ id, name: name || id }));
  const machineId = request.machineId ?? machines[0]?.id;
  if (machineId && !machines.some((m) => m.id === machineId))
    throw new Error('memory_forbidden');
  const check = () => {
    checkScope();
    if (
      machineId &&
      (meta.get(['e', `machine-${machineId}`]) !== true ||
        field(machineId, 'ownerUserId') !== userId)
    )
      throw new Error('memory_forbidden');
  };
  const result: MemorySnapshot = {
    machines,
    machineId,
    entries: [],
    identities: [],
    status: 'unknown',
    cached: false,
  };
  if (!machineId) return result;
  let replica;
  let creating = false;
  try {
    replica = await openSettings(
      `${request.workspaceId}:mf:${machineId}`,
      grant,
      signal,
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'forbidden')
      throw new Error('memory_forbidden');
    const absent = error instanceof Error && error.message === 'not_found';
    if (request.action === 'import' && absent) {
      replica = {
        flock: new Flock(`lody-ios-memory-${crypto.randomUUID()}`),
        client: await clientFor(
          `${request.workspaceId}:mf:${machineId}`,
          grant,
        ),
      };
      creating = true;
    } else if (request.action !== 'list') throw error;
    if (!(error instanceof Error && error.message === 'not_found')) {
      const cached = replicas.get(machineId);
      if (!cached) throw error;
      result.entries = memoryRows(cached, machineId);
      result.cached = true;
    }
  }
  check();
  if (replica) result.entries = memoryRows(replica.flock, machineId);
  const probe = async () => {
    check();
    const online = machineState(presence(), machineId);
    let status: MemoryStatus = online === 'online' ? 'unknown' : online;
    const capabilities = field(machineId, 'protocolCapabilities') as
      Record<string, unknown> | undefined;
    const version = capabilities?.memoryProviders;
    if (online === 'online') {
      status = 'unsupported';
      if (
        typeof version === 'number' &&
        Number.isInteger(version) &&
        version >= 1
      ) {
        try {
          const reply = await machineRpc(
            request.workspaceId,
            machineId,
            'machine/memory',
            { action: 'list', providerId },
            grant,
            signal,
          );
          check();
          if (reply.error) throw new Error(reply.error.code ?? 'error');
          const parsed = memoryInventory.parse(reply.result);
          result.identities = parsed.status === 'ready' ? parsed.memories : [];
          status = parsed.status;
        } catch (error) {
          status = String(error).includes('forbidden') ? 'forbidden' : 'error';
        }
      }
    }
    check();
    result.status = status;
  };
  if (request.action !== 'remove') await probe();
  if (request.action === 'list') return result;
  if (!replica) throw new Error('memory_unavailable');
  const { flock, client } = replica;
  const version = flock.version();
  if (request.action === 'import') {
    if (result.status !== 'ready') throw new Error(`memory_${result.status}`);
    const identity = result.identities.find(
      (entry) => entry.id === request.memoryId,
    );
    if (!identity) throw new Error('memory_conflict');
    const entry = memoryAssociation.parse({
      machineId,
      providerId,
      memoryId: identity.id,
      name: identity.name || identity.id,
      ...(identity.description !== undefined
        ? { description: identity.description }
        : {}),
    });
    const key = ['memory', providerId, identity.id];
    // Stable keys make repeated imports a no-op and preserve customized association metadata.
    if (flock.get(key) !== undefined) {
      if (
        !result.entries.some(
          (e) => e.providerId === providerId && e.memoryId === identity.id,
        )
      )
        throw new Error('memory_conflict');
      return result;
    }
    flock.set(key, entry);
  } else {
    const base = memoryAssociation.parse(request.base);
    if (base.machineId !== machineId) throw new Error('memory_invalid');
    const current = result.entries.find(
      (e) => e.providerId === base.providerId && e.memoryId === base.memoryId,
    );
    if (
      !current ||
      current.name !== base.name ||
      current.description !== base.description
    )
      throw new Error('memory_conflict');
    flock.delete(['memory', base.providerId, base.memoryId]);
  }
  flock.commit();
  signal.throwIfAborted();
  check();
  try {
    if (creating) {
      const created = await client.create({
        contentType: 'application/octet-stream',
      });
      if (!created.ok)
        throw new Error(
          created.result.code === 'forbidden'
            ? 'memory_forbidden'
            : 'memory_write_unknown',
        );
      signal.throwIfAborted();
      check();
    }
    const saved = await client.append({
      part: {
        contentType: 'application/octet-stream',
        body: encodeFrame(
          new TextEncoder().encode(JSON.stringify(flock.exportJson(version))),
        ),
      },
    });
    if (!saved.ok)
      throw new Error(
        saved.result.code === 'forbidden'
          ? 'memory_forbidden'
          : 'memory_write_unknown',
      );
  } catch (error) {
    if (String(error).includes('memory_forbidden')) throw error;
    throw new Error('memory_write_unknown');
  }
  check();
  result.entries = memoryRows(flock, machineId);
  return result;
}
