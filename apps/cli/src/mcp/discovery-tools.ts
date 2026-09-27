import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ResourceListSchemas, type DiscoveryQuery } from '@/lib/discovery-query';
import type { ResourceDiscovery, DiscoveryResource } from '@/lib/resource-discovery';

export function registerDiscoveryTools(
  server: McpServer,
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
    server.registerTool(
      `lody_${resource}_list`,
      {
        description: `${descriptions[resource]} Returns a bounded page (default 20, maximum 100); follow nextCursor with the same filters to enumerate all entries.`,
        inputSchema: ResourceListSchemas[resource],
        annotations: { readOnlyHint: true },
      },
      (args: DiscoveryQuery) => result((discovery) => discovery.list(resource, args))
    );
  }
  for (const resource of ['agent_config', 'agent_role'] as const) {
    server.registerTool(
      `lody_${resource}_get`,
      {
        description: `Read one ${resource} by stable id from its list tool.`,
        inputSchema: z.object({ id: z.string().trim().min(1) }).strict(),
        annotations: { readOnlyHint: true },
      },
      (args) => result((discovery) => discovery.get(resource, args.id))
    );
  }
}
