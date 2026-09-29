import { z } from 'zod';
import {
  buildSessionToolServer,
  runWithMcpSessionContext,
  type McpSessionContext,
} from './lody-mcp-server';
import type { SessionToolHandlers } from './session-tool-router';
import { getSessionRoomId, isLoroRepoDocDeleted, type SessionMeta } from '@lody/shared';
import { getSessionCommandEnvironment } from '@/lib/session-command-environment';

const ResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() }).strict()),
  isError: z.boolean().optional(),
});

/** Only explicitly registered Session/catalog tools cross this IPC boundary. */
export async function executeDaemonSessionTool(
  context: McpSessionContext,
  name: string,
  args: unknown
) {
  const environment = getSessionCommandEnvironment();
  if (
    !environment ||
    context.machineId !== environment.auth.machineId ||
    context.workspaceId !== environment.workspace.id
  )
    throw new Error('Session tool scope mismatch');
  const invocation = environment.host.readInvocation(context.sessionId);
  if (!invocation.active || invocation.requesterUserId !== environment.auth.userId)
    throw new Error('Session tool requires an active local user Turn');
  const row = await environment.manager.repo.getDocMeta(getSessionRoomId(context.sessionId));
  if (
    !row?.meta ||
    isLoroRepoDocDeleted(row) ||
    (row.meta as SessionMeta).machineId !== environment.auth.machineId
  )
    throw new Error('Requester Session does not belong to this machine');
  const handlers: SessionToolHandlers = new Map();
  const server = buildSessionToolServer(handlers);
  try {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Unsupported daemon Session tool: ${name}`);
    const result = await runWithMcpSessionContext(context, () => handler(args));
    return { type: 'session/tool-result' as const, ...ResultSchema.parse(result) };
  } finally {
    await server.close();
  }
}
