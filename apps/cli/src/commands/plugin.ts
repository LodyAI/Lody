import { Command, Option } from 'commander';
import { resolve } from 'node:path';
import { createPlugin } from './plugin-project';
import { runOneShotCommand } from '../lib/command-runtime';
const run = (fn: () => Promise<unknown>) =>
  runOneShotCommand(
    'plugin',
    {},
    async () => {
      console.log(JSON.stringify(await fn(), null, 2));
    },
    { localOnly: true }
  );
export const pluginCommand = new Command('plugin').description('Develop plugins on this machine');
pluginCommand
  .command('create <id>')
  .addOption(
    new Option('--template <name>').choices(['ui', 'sound', 'renderer', 'workflow']).default('ui')
  )
  .action((id, opts) => run(() => createPlugin(id, opts.template)));
pluginCommand
  .command('doctor <path>')
  .description('Validate manifest and declared paths without executing plugin code')
  .action((path) =>
    run(async () => {
      const { checkPlugin } = await import('./plugin-doctor');
      return checkPlugin(resolve(path));
    })
  );
function requireOwner() {
  if (process.env.LODY_AGENT_SESSION_ID !== undefined || !process.stdin.isTTY)
    throw new Error(
      'Activate plugins from an interactive owner terminal outside an agent session.'
    );
}
pluginCommand
  .command('link <path>')
  .requiredOption('--dev', 'Watch and rebuild local plugin source')
  .option('--encrypted-workspace <id>', 'Install in this running encrypted workspace identity')
  .action((path, opts) =>
    run(async () => {
      requireOwner();
      const { requestPluginControl } = await import('../plugins/plugin-control-client');
      return requestPluginControl(
        { action: 'link', path: resolve(path), dev: true },
        opts.encryptedWorkspace
      );
    })
  );
for (const action of ['reload', 'disable', 'remove', 'logs'] as const)
  pluginCommand
    .command(`${action} <id>`)
    .option('--encrypted-workspace <id>', 'Use this running encrypted workspace identity')
    .action((id, opts) =>
      run(async () => {
        if (action !== 'logs') requireOwner();
        const { requestPluginControl } = await import('../plugins/plugin-control-client');
        return requestPluginControl({ action, pluginId: id }, opts.encryptedWorkspace);
      })
    );
