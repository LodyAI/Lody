import {
  AgentRoleCreateProposalSchema,
  AgentRoleUpdateProposalSchema,
  type AgentRoleProposalCommand,
} from '@lody/shared';
import type { createSessionToolRegistrar } from './session-tool-router';

export function registerAgentRoleTools(
  register: ReturnType<typeof createSessionToolRegistrar>,
  execute: (command: AgentRoleProposalCommand) => Promise<unknown>
) {
  const call = async (command: AgentRoleProposalCommand) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await execute(command)) }] };
    } catch (error) {
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
  register(
    'lody_agent_role_create',
    {
      description: `Propose a new private Agent Role. Resolve exact machineId and agentConfigId using discovery. The Role uses the Agent defaults. ${consent}`,
      inputSchema: AgentRoleCreateProposalSchema,
    },
    (args) => call({ action: 'create', ...args })
  );
  register(
    'lody_agent_role_update',
    {
      description: `Propose changes to a Role you manage. Read it with lody_agent_role_get first. Omitted patch fields stay unchanged; empty description or promptPrefix clears that field. Other Role configuration is preserved. ${consent}`,
      inputSchema: AgentRoleUpdateProposalSchema,
    },
    (args) => call({ action: 'update', ...args })
  );
}
