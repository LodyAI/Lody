import type { createSessionToolRegistrar } from './session-tool-router';
import { z } from 'zod';
import { ResourceListSchemas, type DiscoveryQuery } from '@/lib/discovery-query';
import {
  CatalogSyncingError,
  type ResourceDiscovery,
  type DiscoveryResource,
} from '@/lib/resource-discovery';

const resourceGetInputSchema = z.object({ id: z.string().trim().min(1) }).strict();

export function registerDiscoveryTools(
  registerTool: ReturnType<typeof createSessionToolRegistrar>,
  withDiscovery: <T>(read: (discovery: ResourceDiscovery) => Promise<T>) => Promise<T>
) {
  const descriptions: Record<DiscoveryResource, string> = {
    machine:
      'List readable machines, including offline machines, with online/offline/unknown presence and protocol capabilities.',
    project:
      'List readable local projects across machines and enabled GitHub repositories. kind and machineId restrict the catalog. Local project identity includes machineId.',
    agent_config:
      'List readable Agent configurations across machines, with model and run-config capabilities. Launch commands and credentials are omitted.',
    agent_role:
      'Discover readable Agent Roles and stable ids for session_create. Unavailable Roles remain listed with reasons. get returns the prompt prefix.',
    mcp: 'List workspace MCP server summaries without connection values. selectedForCurrentTurn describes selection, not successful runtime loading.',
  };
  const result = async (read: (discovery: ResourceDiscovery) => Promise<unknown>) => {
    try {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(await withDiscovery(read)) }],
      };
    } catch (error) {
      if (error instanceof CatalogSyncingError)
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: false, error: error.toLodyError() }),
            },
          ],
        };
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: error instanceof Error ? error.message : 'Discovery failed',
          },
        ],
      };
    }
  };
  for (const resource of Object.keys(ResourceListSchemas) as DiscoveryResource[]) {
    registerTool(
      `lody_${resource}_list`,
      {
        description: `${descriptions[resource]} Returns a bounded page (default 20, maximum 100); follow nextCursor with the same filters to enumerate all entries. If sync.state is syncing, cached results may be incomplete; retry before treating absence as final.`,
        inputSchema: ResourceListSchemas[resource],
        annotations: { readOnlyHint: true },
      },
      (args: DiscoveryQuery) => result((discovery) => discovery.list(resource, args))
    );
  }
  for (const resource of ['agent_config', 'agent_role'] as const) {
    registerTool(
      `lody_${resource}_get`,
      {
        description: `Read one ${resource} by stable id from its list tool. CATALOG_SYNCING is retryable.`,
        inputSchema: resourceGetInputSchema,
        annotations: { readOnlyHint: true },
      },
      (args) => result((discovery) => discovery.get(resource, args.id))
    );
  }
}
