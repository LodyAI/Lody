import { z } from 'zod/v4';

export const ProbeSchemaParams = z
  .object({ workspaceId: z.string().min(1) })
  .meta({ id: 'ProbeSchemaParams' });

export const CapabilityProbe = z
  .object({
    key: z.array(z.string()),
    cliType: z.unknown().optional(),
    agentType: z.unknown().optional(),
    models: z.unknown().optional(),
    modes: z.unknown().optional(),
    modelReasoningEfforts: z.unknown().optional(),
    configOptionFields: z.array(z.string()),
  })
  .meta({ id: 'CapabilityProbe' });

export const MachineProbe = z
  .object({
    otherKeys: z.array(z.string()),
    capabilities: z.array(CapabilityProbe),
  })
  .meta({ id: 'MachineProbe' });

export const ProbeSchemaReport = z
  .object({
    creationOptionsTrial: z.record(z.string(), z.string()),
    machines: z.record(z.string(), MachineProbe),
  })
  .meta({ id: 'ProbeSchemaReport' });
