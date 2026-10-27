import { Command } from 'commander';

export type DshProvider = { id: string; name: string };

export async function selectDshProvider(
  providers: DshProvider[],
  configId: string | undefined,
  interactive: boolean,
  prompt: (providers: DshProvider[]) => Promise<string>
): Promise<DshProvider> {
  if (!providers.length)
    throw new Error('No local DSH Providers are available. Create one in Lody first.');
  if (!configId) {
    if (!interactive)
      throw new Error('Pass --agent-config <id> when not running in an interactive terminal.');
    configId = await prompt(providers);
  }
  const provider = providers.find((item) => item.id === configId);
  if (!provider) throw new Error('Local DSH Provider not found. Choose an id from this machine.');
  return provider;
}

export function createDshCommand(
  run: (args: string[], configId?: string) => Promise<void> = runPluginCommand
): Command {
  return new Command('dsh').description('Manage this machine’s DSH Providers').addCommand(
    new Command('plugin')
      .description('Run native dsh plugin commands in a local Provider’s lody-acp profile')
      .argument('<args...>', 'Native arguments, e.g. add <package> or remove <package>')
      .option('--agent-config <id>', 'Local DSH Provider id; prompts when omitted')
      .allowUnknownOption()
      .action(async (args: string[], options: { agentConfig?: string }) => {
        if (
          args.some((arg) => arg === '--profile' || arg.startsWith('--profile=') || /^-p/.test(arg))
        ) {
          throw new Error(
            'The profile is bound to the selected Lody Provider; do not pass --profile.'
          );
        }
        await run(args, options.agentConfig);
      })
  );
}

async function runPluginCommand(args: string[], configId?: string): Promise<void> {
  const { runOneShotCommand } = await import('@/lib/command-runtime');
  await runOneShotCommand('dsh', {}, async () => {
    const { Effect } = await import('effect');
    const { makeLocalControlClientAuto, makeLocalProbeClientAuto } =
      await import('@lody/shared/node/local-ipc');
    const health = await Effect.runPromise(makeLocalProbeClientAuto().health());
    const responses = await Effect.runPromise(
      makeLocalControlClientAuto().sessionControl({
        type: 'machine/dsh-providers',
        machineId: health.machineId as import('@lody/shared').MachineId,
      })
    );
    const response = responses.find((item) => item.type === 'machine/dsh-providers_response');
    if (!response || !response.success)
      throw new Error(
        response?.error ?? 'Cannot read local DSH Providers. Update and start the Lody daemon.'
      );
    const provider = await selectDshProvider(
      response.providers,
      configId,
      Boolean(process.stdin.isTTY && process.stdout.isTTY),
      async (providers) => {
        const { default: inquirer } = await import('inquirer');
        const answer = await inquirer.prompt<{ id: string }>([
          {
            type: 'list',
            name: 'id',
            message: 'Choose a local DSH Provider:',
            choices: providers.map((item) => ({
              name: `${item.name} (${item.id})`,
              value: item.id,
            })),
          },
        ]);
        return answer.id;
      }
    );
    const { resolveCliAdapterEntry } = await import('@/agent/setting');
    const { resolveDeepSeekHarnessProcessLaunch } =
      await import('@/agent/deepseek-harness-runtime');
    const { runDshPlugin } = await import('@/agent/dsh-plugins');
    const { fileLocksLegacy } = await import('@/utils/file-lock');
    const { platformLayer } = await import('@/platform/process-options');
    const [adapterPath] = resolveCliAdapterEntry('deepseek-acp');
    const launch = await resolveDeepSeekHarnessProcessLaunch({
      adapterPath,
      providerId: provider.id,
      pluginArgs: args,
    });
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    try {
      const code = await fileLocksLegacy.runPromise(
        runDshPlugin(launch, process.cwd()).pipe(Effect.provide(platformLayer({}))),
        { signal: controller.signal }
      );
      if (code !== 0)
        throw Object.assign(new Error(`DSH plugin command exited with code ${code}.`), {
          exitCode: code,
        });
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
  });
}

export const dshCommand = createDshCommand();
