import type { InstallationKey } from './client-host';
const key = (i: InstallationKey) => JSON.stringify([i.workspaceId, i.sourceKey, i.pluginId]);
const records = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();
let version = 0;
export const clientDiagnostics = {
  read: (i: InstallationKey) => records.get(key(i)) ?? [],
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  snapshot: () => version,
  report: (i: InstallationKey, code: string, detail: string) => {
    const k = key(i);
    const row = `${code}: ${detail.slice(0, 2048)}`;
    const prior = records.get(k) ?? [];
    if (prior.includes(row)) return;
    records.set(k, [...prior.slice(-63), row]);
    version++;
    listeners.forEach((f) => f());
  },
  clear: (i: InstallationKey) => {
    if (records.delete(key(i))) {
      version++;
      listeners.forEach((f) => f());
    }
  },
};
