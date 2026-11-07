import type { z } from 'zod/v4';
import type { MachineProbe } from '../../contract/debug.ts';
import { creationOptions } from '../create-session';
import type { RuntimeContext } from './context.ts';

export function registerDebug({ channel, state }: RuntimeContext) {
  channel.handle('probeSchema', ({ workspaceId }) => {
    if (workspaceId !== state.workspace) throw new Error('metadata_not_ready');
    // Development probe. `acpCapability` is a published capability catalog —
    // model and mode names are exactly what the picker must show, so its
    // values are safe to report. `agentConfig.env` carries launch secrets and
    // never leaves the WebView; only its field names are reported.
    const names = (value: unknown): string[] =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value as Record<string, unknown>).sort()
        : [];
    const trials: Record<string, string> = {};
    for (const catalog of state.catalogs.values())
      for (const project of catalog.projects) {
        if (trials[project.id]) continue;
        try {
          const value = creationOptions(
            project.id,
            state.metaReplica!.flock,
            state.machineReplicas,
          );
          trials[project.id] =
            `ok agents=${value.agents.length} capabilities=${value.capabilities.length}`;
        } catch (error) {
          trials[project.id] = `THREW ${String(
            error,
          )} | ${(error as Error)?.stack ?? ''}`.slice(0, 400);
        }
      }
    const machines: Record<string, z.input<typeof MachineProbe>> = {};
    for (const [machineId, flock] of state.machineReplicas) {
      const capabilities: z.input<typeof MachineProbe>['capabilities'] = [];
      const otherKeys = new Set<string>();
      for (const row of flock.scan()) {
        const kind = String(row.key[0]);
        if (kind !== 'acpCapability') {
          otherKeys.add(kind);
          continue;
        }
        const value = (row.value ?? {}) as Record<string, unknown>;
        capabilities.push({
          key: row.key.map(String),
          cliType: value.cliType,
          agentType: value.agentType,
          models: value.models,
          modes: value.modes,
          modelReasoningEfforts: value.modelReasoningEfforts,
          configOptionFields: names(value.configOptions),
        });
      }
      machines[machineId] = { otherKeys: [...otherKeys].sort(), capabilities };
    }
    return { creationOptionsTrial: trials, machines };
  });
}
