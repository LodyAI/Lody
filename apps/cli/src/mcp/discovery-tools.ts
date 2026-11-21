import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ResourceListSchemas, type DiscoveryQuery } from '@/lib/discovery-query';
import {
  CatalogSyncingError,
  type ResourceDiscovery,
  type DiscoveryResource,
} from '@/lib/resource-discovery';
import { defineToolAction, type LodyToolAction } from './tool-help';

const resourceGetInputSchema = z.object({ id: z.string().trim().min(1) }).strict();

/** Catalog action names, keyed by the discovery resource each one reads. */
export const CATALOG_DISCOVERY_ACTIONS = {
  machines: 'machine',
  projects: 'project',
  mcp_servers: 'mcp',
  agent_configs: 'agent_config',
  agent_roles: 'agent_role',
} as const satisfies Record<string, DiscoveryResource>;
export type CatalogDiscoveryAction = keyof typeof CATALOG_DISCOVERY_ACTIONS;

/** Read-only workspace listings for `lody_catalog`; every action pages the same way. */
export function discoveryCatalogActions(
  withDiscovery: <T>(read: (discovery: ResourceDiscovery) => Promise<T>) => Promise<T>
): Record<CatalogDiscoveryAction, LodyToolAction> {
  const summaries: Record<DiscoveryResource, string> = {
    machine: 'Machine ids, liveness, capabilities and quotas; optionally memory and disk.',
    project: 'Local projects and enabled GitHub repositories for explicit workspace selection.',
    mcp: 'Workspace MCP configurations and current-turn selections, without connection values.',
    agent_config: 'Agent configurations and their supported models and run options, or one by id.',
    agent_role:
      'Saved agent Roles, target machines/configurations and availability, or one Role by id.',
  };
  const descriptions: Record<DiscoveryResource, string> = {
    machine:
      'List readable machines, including offline machines, with online/offline/unknown presence, protocol capabilities and synced agent quota windows (most used first, with reset times). Pass includeResources to also ask each listed online machine for memory and disk; a machine that cannot answer reports resources unavailable.',
    project:
      'List readable local projects across machines and enabled GitHub repositories. kind and machineId restrict the catalog. Local project identity includes machineId.',
    agent_config:
      'List readable Agent configurations across machines, with model and run-config capabilities. Launch commands and credentials are omitted.',
    agent_role:
      'Discover readable Agent Roles and stable ids for session_create. Unavailable Roles remain listed with reasons. Reading one by id returns the prompt prefix.',
    mcp: 'List workspace MCP server summaries without connection values. selectedForCurrentTurn describes selection, not successful runtime loading.',
  };
  const result = async (
    read: (discovery: ResourceDiscovery) => Promise<unknown>
  ): Promise<CallToolResult> => {
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
  const listDescription = (resource: DiscoveryResource) =>
    `${descriptions[resource]} Returns a bounded page (default 20, maximum 100); follow nextCursor with the same filters to enumerate all entries. If sync.state is syncing, cached results may be incomplete; retry before treating absence as final.`;
  const listAction = (resource: 'machine' | 'project' | 'mcp') =>
    defineToolAction({
      summary: summaries[resource],
      description: listDescription(resource),
      inputSchema: ResourceListSchemas[resource],
      run: (args: DiscoveryQuery) => result((discovery) => discovery.list(resource, args)),
    });
  // Read one by id or list a page; each mode keeps its own schema and defaults.
  const listOrGetAction = (resource: 'agent_config' | 'agent_role') => {
    const listSchema = ResourceListSchemas[resource];
    return defineToolAction({
      summary: summaries[resource],
      description: `${listDescription(resource)}\n\nPass id (a stable id from a list page) instead of list filters to read one ${resource}. CATALOG_SYNCING is retryable.`,
      inputSchema: z
        .object({
          id: z.string().trim().min(1).optional().describe('Read one by stable id.'),
          ...listSchema.shape,
          // Absence must survive to get-mode validation, which rejects list fields.
          limit: listSchema.shape.limit.unwrap().optional(),
        })
        .strict()
        .superRefine((value, ctx) => {
          const parsed = (value.id === undefined ? listSchema : resourceGetInputSchema).safeParse(
            value
          );
          if (!parsed.success)
            for (const issue of parsed.error.issues)
              ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
        }),
      run: (args) => {
        if (args.id === undefined) {
          const query: DiscoveryQuery = listSchema.parse(args);
          return result((discovery) => discovery.list(resource, query));
        }
        const { id } = resourceGetInputSchema.parse(args);
        return result((discovery) => discovery.get(resource, id));
      },
    });
  };
  return {
    machines: listAction('machine'),
    projects: listAction('project'),
    mcp_servers: listAction('mcp'),
    agent_configs: listOrGetAction('agent_config'),
    agent_roles: listOrGetAction('agent_role'),
  };
}
