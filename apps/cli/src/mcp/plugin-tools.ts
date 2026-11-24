import {
  pluginProposalActions,
  pluginProposalInput,
  type PluginProposalCommand,
} from '@lody/shared/plugins/proposal';
import type { createSessionToolRegistrar } from './session-tool-router';
import { actionToolInputSchema, defineToolAction, runToolAction } from './tool-help';
export function registerPluginTools(
  register: ReturnType<typeof createSessionToolRegistrar>,
  execute: (command: PluginProposalCommand) => Promise<unknown>
) {
  const actions = Object.fromEntries(
    pluginProposalActions.map((action) => [
      action,
      defineToolAction({
        summary: `Propose ${action.slice(8)} for human review.`,
        description:
          'Review the verified package in the current Session. No code is installed, enabled or reloaded. packagePath is a release package inside the Session worktree; requestId identifies retries.',
        inputSchema: pluginProposalInput,
        run: async (args) => ({
          content: [{ type: 'text', text: JSON.stringify(await execute({ action, ...args })) }],
        }),
      }),
    ])
  );
  register(
    'lody_plugin',
    {
      title: 'Plugin proposals',
      summary: 'Propose a plugin installation, enable or reload for human review.',
      description: 'Publish a review card in the current Session. No activation actions.',
      inputSchema: actionToolInputSchema(actions, pluginProposalActions.join(', ')),
      actions,
    },
    (args) => runToolAction(actions, args)
  );
}
