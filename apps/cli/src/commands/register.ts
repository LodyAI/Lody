import { Command } from 'commander';
import { getCliPlatformKind } from '../lib/cli-platform';

const commands = [
  {
    name: 'login',
    description: 'Login to Lody using device authorization flow or an API key',
    usage: '[options]',
    load: async () => (await import('./login')).loginCommand,
  },
  {
    name: 'logout',
    description: 'Logout from Lody and clear saved authentication',
    usage: '[options]',
    load: async () => (await import('./logout')).logoutCommand,
  },
  {
    name: 'start',
    description: 'Start agent service in native mode',
    usage: '[options]',
    load: async () => (await import('./start')).startCommand,
  },
  {
    name: 'app',
    description:
      'Open the Lody desktop app on a new chat with a local directory selected (registers it if needed)',
    usage: '[options] [command] [path]',
    load: async () => (await import('./app')).appCommand,
  },
  {
    name: 'project',
    description: 'Manage local projects',
    usage: '[options] [command]',
    load: async () => (await import('./project')).projectCommand,
  },
  {
    name: 'session',
    description: 'Manage sessions without the web UI',
    usage: '[options] [command]',
    load: async () => (await import('./session')).sessionCommand,
  },
  {
    name: 'schedule',
    description: 'Manage scheduled tasks. The target machine daemon owns execution.',
    usage: '[options] [command]',
    load: async () => (await import('./schedule')).scheduleCommand,
  },
  {
    name: 'automation',
    description: 'Wait for a JavaScript condition and continue the registering Session.',
    usage: '[options] [command]',
    load: async () => (await import('./automation')).automationCommand,
  },
  {
    name: 'sync',
    description: 'Sync workspace Loro data to the local cache',
    usage: '[options]',
    load: async () => (await import('./sync')).syncCommand,
  },
  {
    name: 'workspace',
    description: 'Manage workspaces',
    usage: '[options] [command]',
    load: async () => (await import('./workspace')).workspaceCommand,
  },
  {
    name: 'agent-config',
    description: 'Manage agent configs',
    usage: '[options] [command]',
    load: async () => (await import('./agent-config')).agentConfigCommand,
  },
  {
    name: 'dsh',
    description: 'Manage this machine\u2019s DSH Providers',
    usage: '[options] [command]',
    load: async () => (await import('./dsh')).dshCommand,
  },
  {
    name: 'mcp',
    description: 'Manage workspace MCP servers',
    usage: '[options] [command]',
    load: async () => (await import('./mcp')).mcpCommand,
  },
  {
    name: 'agent-role',
    description: 'Inspect Agent Roles and propose creations or updates',
    usage: '[options] [command]',
    load: async () => (await import('./discovery')).agentRoleCommand,
  },
  {
    name: 'operation',
    description: 'Inspect Operations on this machine',
    usage: '[options] [command]',
    load: async () => (await import('./operation')).operationCommand,
  },
  {
    name: 'machine',
    description: 'Inspect and pair machines',
    usage: '[options] [command]',
    load: async () => (await import('./machine')).machineCommand,
  },
  {
    name: 'export',
    description: 'Export user-facing workspace session data',
    usage: '[options] [outputDir]',
    load: async () => (await import('./export')).exportCommand,
  },
  {
    name: 'migrate',
    description: 'Import a frozen OSS snapshot into an existing cloud workspace',
    usage: '[options]',
    load: async () => (await import('./migrate')).migrateCommand,
    cloudOnly: true,
  },
  {
    name: 'review',
    description: 'Render a .review.md into a self-contained HTML review and open it',
    usage: '[options] [command] [file]',
    load: async () => (await import('./review')).reviewCommand,
  },
  {
    name: 'github',
    description: 'Manage GitHub repositories linked to a workspace',
    usage: '[options] [command]',
    load: async () => (await import('./github')).githubCommand,
  },
  {
    name: 'daemon',
    description: 'Run lody as a background daemon service',
    usage: '[options] [command]',
    load: async () => (await import('./daemon')).daemonCommand,
  },
  {
    name: 'daemon-runner',
    description: '(internal) daemon watchdog process',
    usage: '[options]',
    load: async () => (await import('./daemon-runner')).daemonRunnerCommand,
  },
  {
    name: '__internal',
    description: '(internal) Lody helper commands',
    usage: '[options] [command]',
    load: async () => (await import('./internal')).internalCommand,
  },
  {
    name: 'feedback',
    description: 'Send product feedback with account identity and basic CLI/OS information',
    usage: '[options] [feedback...]',
    load: async () => (await import('./feedback')).feedbackCommand,
  },
  {
    name: 'e2ee',
    description: 'Local encrypted-workspace maintenance',
    usage: '[options] [command]',
    load: async () => (await import('./e2ee')).e2eeCommand,
    hidden: true,
  },
];

export function registerCommands(program: Command): void {
  for (const entry of commands) {
    if ('cloudOnly' in entry && getCliPlatformKind() !== 'cloud') continue;
    const placeholder = new Command(entry.name).description(entry.description).usage(entry.usage);
    program.addCommand(placeholder, { hidden: 'hidden' in entry });
    placeholder
      .helpOption(false)
      .allowUnknownOption()
      .allowExcessArguments()
      .passThroughOptions()
      .action(async () => {
        const implementation = await entry.load();
        implementation.parent = program;
        await implementation.parseAsync(placeholder.args, { from: 'user' });
      });
  }
}
