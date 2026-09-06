import type { SessionId } from '@lody/shared';
import type { ProcessTableEntry } from './process-table';

export type ProcessTreeRootSet = {
  sessionId: SessionId;
  rootPids: number[];
};

export type ProcessTreeAggregate = {
  memoryBytes: number;
  cpuTimeMicros: number;
  processCount: number;
};

export function aggregateProcessTreeUsage(
  entries: readonly ProcessTableEntry[],
  roots: readonly ProcessTreeRootSet[]
): Map<SessionId, ProcessTreeAggregate> {
  const entryByPid = new Map(entries.map((entry) => [entry.pid, entry]));
  const ownerByRootPid = new Map<number, SessionId>();
  for (const rootSet of roots) {
    for (const pid of rootSet.rootPids) {
      if (!ownerByRootPid.has(pid)) ownerByRootPid.set(pid, rootSet.sessionId);
    }
  }

  const aggregates = new Map<SessionId, ProcessTreeAggregate>();
  for (const rootSet of roots) {
    aggregates.set(rootSet.sessionId, { memoryBytes: 0, cpuTimeMicros: 0, processCount: 0 });
  }

  for (const entry of entries) {
    const owner = resolveOwner(entry, entryByPid, ownerByRootPid);
    if (!owner) continue;
    const aggregate = aggregates.get(owner);
    if (!aggregate) continue;
    aggregate.memoryBytes += entry.memoryBytes;
    aggregate.cpuTimeMicros += entry.cpuTimeMicros;
    aggregate.processCount += 1;
  }
  return aggregates;
}

function resolveOwner(
  entry: ProcessTableEntry,
  entryByPid: ReadonlyMap<number, ProcessTableEntry>,
  ownerByRootPid: ReadonlyMap<number, SessionId>
): SessionId | null {
  const directOwner = ownerByRootPid.get(entry.pid);
  if (directOwner) return directOwner;
  if (entry.processGroupId !== null) {
    const groupOwner = ownerByRootPid.get(entry.processGroupId);
    if (groupOwner) return groupOwner;
  }

  const seen = new Set<number>([entry.pid]);
  let child = entry;
  while (child.parentPid > 0 && !seen.has(child.parentPid)) {
    seen.add(child.parentPid);
    const parent = entryByPid.get(child.parentPid);
    if (!parent || parent.startedAtMs > child.startedAtMs) return null;
    const parentOwner = ownerByRootPid.get(parent.pid);
    if (parentOwner) return parentOwner;
    child = parent;
  }
  return null;
}

/** Root identities are pinned for each observed session generation, never reused by PID alone. */
export class ObservedProcessAttribution {
  private readonly roots = new Map<string, number>();

  assign(
    entries: readonly ProcessTableEntry[],
    roots: readonly (ProcessTreeRootSet & { startedAtMs: number | null })[]
  ): Map<number, SessionId> {
    const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
    const owners = new Map<number, SessionId>();
    const currentKeys = new Set<string>();
    for (const root of roots) {
      for (const pid of root.rootPids) {
        const key = `${root.sessionId}:${root.startedAtMs}:${pid}`;
        currentKeys.add(key);
        const entry = byPid.get(pid);
        if (!entry) continue;
        const pinned = this.roots.get(key);
        if (pinned === undefined) this.roots.set(key, entry.startedAtMs);
        if ((pinned ?? entry.startedAtMs) === entry.startedAtMs) owners.set(pid, root.sessionId);
      }
    }
    for (const key of this.roots.keys()) if (!currentKeys.has(key)) this.roots.delete(key);
    const result = new Map<number, SessionId>();
    for (const entry of entries) {
      const owner = resolveOwner(entry, byPid, owners);
      if (owner) result.set(entry.pid, owner);
    }
    return result;
  }
}
