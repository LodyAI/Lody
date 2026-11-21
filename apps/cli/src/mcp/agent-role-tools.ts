import {
  AgentRoleCreateProposalSchema,
  AgentRoleUpdateProposalSchema,
  type AgentRoleProposalCommand,
} from '@lody/shared';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { createSessionToolRegistrar } from './session-tool-router';
import { actionToolInputSchema, defineToolAction, runToolAction } from './tool-help';

export const AGENT_ROLE_TOOL_NAME = 'lody_agent_role';

/** `lody_agent_role` proposes Role changes; reads are the read-only `lody_catalog` `agent_roles` action. */
export function registerAgentRoleTools(
  register: ReturnType<typeof createSessionToolRegistrar>,
  execute: (command: AgentRoleProposalCommand) => Promise<unknown>,
  errorResult?: (error: unknown) => CallToolResult
) {
  const call = async (command: AgentRoleProposalCommand): Promise<CallToolResult> => {
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
  const actions = {
    create: defineToolAction({
      summary:
        'Propose a reusable agent Role with instructions and a machine binding; user Save is required.',
      description: `Propose a new private Agent Role. Resolve exact machineId and agentConfigId using discovery. The Role uses the Agent defaults. ${consent}`,
      inputSchema: AgentRoleCreateProposalSchema,
      run: (args) => call({ action: 'create', ...args }),
    }),
    update: defineToolAction({
      summary: 'Propose instruction/name edits to a saved agent Role; user Save is required.',
      description: `Propose changes to a Role you manage. Read it first with lody_catalog action agent_roles and its id. Omitted patch fields stay unchanged; empty description or promptPrefix clears that field. Other Role configuration is preserved. ${consent}`,
      inputSchema: AgentRoleUpdateProposalSchema,
      run: (args) => call({ action: 'update', ...args }),
    }),
  };
  register(
    AGENT_ROLE_TOOL_NAME,
    {
      summary:
        'Propose a new agent Role or edits to a saved one; the user must press Save. Read Roles with lody_catalog.',
      title: 'Propose Lody Agent Roles',
      description:
        'Actions: create and update. Both only propose: they write a review card and change nothing until the user presses Save. Read Roles with lody_catalog action agent_roles.',
      inputSchema: actionToolInputSchema(actions, 'create or update.'),
      actions,
    },
    (input) => runToolAction(actions, input)
  );
}
