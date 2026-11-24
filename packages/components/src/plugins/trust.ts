import { pluginSafeMode } from './safe-mode';
import type { PluginManifest } from '@lody/shared/plugins/manifest-schema';

export interface DevInstallation {
  workspaceId: string;
  machineId: string;
  manifest: PluginManifest;
  devSessionNonce?: string;
  owner: boolean;
  devMode: boolean;
}

function identity(i: DevInstallation) {
  return JSON.stringify([i.workspaceId, i.machineId, i.manifest.id]);
}
function capabilities(m: PluginManifest) {
  return [
    m.machine && 'machine',
    m.mcpServers?.length && 'mcpServers',
    m.acpProviders?.length && 'acpProviders',
    Object.values(m.config ?? {}).some((f) => f.type === 'secret') && 'secret',
  ].filter((s): s is string => typeof s === 'string');
}

/** Owned by one tab. Feed every catalog transition through allows, including dev unlink. */
export class TrustedDevSessionStore {
  private readonly leases = new Map<string, { nonce: string; capabilities: Set<string> }>();
  grant(i: DevInstallation) {
    if (pluginSafeMode()) {
      this.clear();
      throw new Error('Plugins disabled in safe mode');
    }
    if (!i.owner || !i.devMode || !i.devSessionNonce || !/^[a-f0-9]{32}$/.test(i.devSessionNonce))
      throw new Error('Dev session unavailable');
    this.leases.set(identity(i), {
      nonce: i.devSessionNonce,
      capabilities: new Set(capabilities(i.manifest)),
    });
  }
  allows(i: DevInstallation) {
    if (pluginSafeMode()) {
      this.clear();
      return false;
    }
    const lease = this.leases.get(identity(i));
    if (
      lease &&
      i.devMode &&
      i.owner &&
      lease.nonce === i.devSessionNonce &&
      capabilities(i.manifest).every((c) => lease.capabilities.has(c))
    )
      return true;
    this.revoke(i);
    return false;
  }
  revoke(i: DevInstallation) {
    this.leases.delete(identity(i));
  }
  clear() {
    this.leases.clear();
  }
}
