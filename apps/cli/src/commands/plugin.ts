import { Command, Option } from 'commander';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';
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
pluginCommand
  .command('preview <path>')
  .description('Preview synthetic sessions in a browser sandbox')
  .option('--output <file>', 'Save standalone HTML to a new file')
  .option('--no-open', 'Do not launch a browser')
  .action(async (path, opts) => {
    const { previewPlugin } = await import('./plugin-preview');
    await previewPlugin(path, opts);
  });
function rejectCooperativeAgentActivation() {
  if (process.env.LODY_AGENT_SESSION_ID !== undefined)
    throw new Error('Agent sessions must propose plugin activation for human approval.');
}
pluginCommand
  .command('link <path>')
  .requiredOption('--dev', 'Watch and rebuild local plugin source')
  .option('--encrypted-workspace <id>', 'Install in this running encrypted workspace identity')
  .action((path, opts) =>
    run(async () => {
      rejectCooperativeAgentActivation();
      const { requestPluginControl } = await import('../plugins/plugin-control-client');
      return requestPluginControl(
        { action: 'link', path: resolve(path), dev: true },
        opts.encryptedWorkspace
      );
    })
  );
for (const action of ['reload', 'disable', 'logs', 'rollback'] as const)
  pluginCommand
    .command(`${action} <id>`)
    .option('--encrypted-workspace <id>', 'Use this running encrypted workspace identity')
    .action((id, opts) =>
      run(async () => {
        if (action !== 'logs') rejectCooperativeAgentActivation();
        const { requestPluginControl } = await import('../plugins/plugin-control-client');
        return requestPluginControl({ action, pluginId: id }, opts.encryptedWorkspace);
      })
    );

pluginCommand
  .command('remove <id>')
  .option(
    '--purge-data',
    'Delete this plugin’s data directory, stored values and event cursors after stopping it'
  )
  .option('--encrypted-workspace <id>', 'Use this running encrypted workspace identity')
  .action((id, opts) =>
    run(async () => {
      const { requestPluginControl } = await import('../plugins/plugin-control-client');
      return requestPluginControl(
        { action: 'remove', pluginId: id, ...(opts.purgeData ? { purgeData: true as const } : {}) },
        opts.encryptedWorkspace
      );
    })
  );

pluginCommand
  .command('pack <directory>')
  .option('-o, --output <file>', 'New output archive path')
  .action((directory, opts) =>
    run(async () => {
      const { packPlugin } = await import('../plugins/plugin-package');
      return packPlugin(
        resolve(directory),
        resolve(opts.output ?? `${basename(resolve(directory))}.tgz`)
      );
    })
  );
pluginCommand
  .command('install <path>')
  .description('Verify and install or update a local release')
  .option('--encrypted-workspace <id>')
  .action((input, opts) =>
    run(async () => {
      rejectCooperativeAgentActivation();
      const { inspectProposalPackage, packPlugin } = await import('../plugins/plugin-package');
      let path = resolve(input);
      const temp = await mkdtemp(join(tmpdir(), 'lody-install-'));
      try {
        if ((await stat(path)).isDirectory()) {
          const dest = join(temp, 'release.tgz');
          await packPlugin(path, dest);
          path = dest;
        }
        const info = await inspectProposalPackage(path);
        const { requestPluginControl } = await import('../plugins/plugin-control-client');
        return await requestPluginControl(
          { action: 'install', path, sha256: info.sha256 },
          opts.encryptedWorkspace
        );
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    })
  );
