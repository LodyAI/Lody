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
  const summaries: Record<'machine' | 'project' | 'mcp', string> = {
    machine:
      'Discover machine ids, liveness, capabilities and quotas; optionally inspect resources.',
    project:
      'Find local projects and enabled GitHub repositories for explicit workspace selection.',
    mcp: 'List workspace MCP configurations and current-turn selections, without connection values.',
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
  const listDescription = (resource: DiscoveryResource) =>
    `${descriptions[resource]} Returns a bounded page (default 20, maximum 100); follow nextCursor with the same filters to enumerate all entries. If sync.state is syncing, cached results may be incomplete; retry before treating absence as final.`;
  for (const resource of ['machine', 'project', 'mcp'] as const) {
    registerTool(
      `lody_${resource}_list`,
      {
        summary: summaries[resource],
        description: listDescription(resource),
        inputSchema: ResourceListSchemas[resource],
        annotations: { readOnlyHint: true },
      },
      (args: DiscoveryQuery) => result((discovery) => discovery.list(resource, args))
    );
  }
  // Read one by id or list a page: one tool per resource, each mode keeping its own schema.
  for (const resource of ['agent_config', 'agent_role'] as const) {
    const listSchema = ResourceListSchemas[resource];
    registerTool(
      `lody_${resource}`,
      {
        summary:
          resource === 'agent_role'
            ? 'Find saved agent Roles, or read one Role instructions, target bindings and pinned run configuration.'
            : 'Find agent configurations across machines, or read one configuration supported models and run options.',
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
        annotations: { readOnlyHint: true },
      },
      (args) => {
        if (args.id === undefined) {
          const query: DiscoveryQuery = listSchema.parse(args);
          return result((discovery) => discovery.list(resource, query));
        }
        const { id } = resourceGetInputSchema.parse(args);
        return result((discovery) => discovery.get(resource, id));
      }
    );
  }
}
