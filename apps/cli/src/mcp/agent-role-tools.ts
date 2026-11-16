import {
  AgentRoleCreateProposalSchema,
  AgentRoleUpdateProposalSchema,
  type AgentRoleProposalCommand,
} from '@lody/shared';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { createSessionToolRegistrar } from './session-tool-router';

export function registerAgentRoleTools(
  register: ReturnType<typeof createSessionToolRegistrar>,
  execute: (command: AgentRoleProposalCommand) => Promise<unknown>,
  errorResult?: (error: unknown) => CallToolResult
) {
  const call = async (command: AgentRoleProposalCommand) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await execute(command)) }] };
    } catch (error) {
      if (errorResult) return errorResult(error);
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: error instanceof Error ? error.message : 'Role proposal failed',
          },
        ],
      };
    }
  };
  const consent =
    'Writes a review card in the current conversation. The Role changes only when the user presses Save; report pending until then. Reuse requestId when retrying. Only propose changes the user requested.';
  const memory =
    "Memory is { providerId, memoryId } on the same machine (lody_memory_list lists imported identities). An identity the machine's provider lists but Lody has not imported is imported when the user saves.";
  register(
    'lody_agent_role_create',
    {
      summary:
        'Propose a reusable agent Role with instructions and a machine binding; user Save is required.',
      description: `Propose a new private Agent Role. Resolve exact machineId and agentConfigId using discovery. The Role uses the Agent defaults. ${memory} ${consent}`,
      inputSchema: AgentRoleCreateProposalSchema,
    },
    (args) => call({ action: 'create', ...args })
  );
  register(
    'lody_agent_role_update',
    {
      summary:
        'Propose name, instruction, machine or per-machine memory edits to a saved agent Role; user Save is required.',
      description: `Propose changes to a Role you manage. Read it with lody_agent_role_get first. Omitted patch fields stay unchanged; empty description or promptPrefix clears that field. patch.targets entries name a machine: agentConfigId adds a machine the Role does not run on yet, using that Agent's defaults (an existing target keeps its Agent config); memory binds an identity on that machine, null unlinks it. Other Role configuration is preserved. ${memory} ${consent}`,
      inputSchema: AgentRoleUpdateProposalSchema,
    },
    (args) => call({ action: 'update', ...args })
  );
}
