import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ loaded: false, options: undefined as unknown, help: '' }));
vi.mock('../src/lib/cli-platform', () => ({ getCliPlatformKind: () => 'local' }));
vi.mock('../src/commands/start', async () => {
  state.loaded = true;
  const { Command } = await import('commander');
  return {
    startCommand: new Command('start').option('--machine-name <name>').action((options) => {
      state.options = options;
    }),
  };
});
vi.mock('../src/commands/session', async () => {
  const { Command } = await import('commander');
  return {
    sessionCommand: new Command('session')
      .exitOverride()
      .configureOutput({
        writeOut: (text) => {
          state.help += text;
        },
      })
      .addCommand(
        new Command('show')
          .alias('get')
          .argument('<id>')
          .option('--json')
          .action((id, options, command) => {
            state.options = { id, ...options, parent: command.parent?.name() };
          })
      ),
  };
});
vi.mock('../src/commands/login', () => {
  throw new Error('unselected login implementation loaded');
});
import { registerCommands } from '../src/commands/register';

function program() {
  const command = new Command('lody').enablePositionalOptions().exitOverride();
  registerCommands(command);
  return command;
}

describe('command lazy dispatch', () => {
  it('renders root help without loading implementations', () => {
    expect(program().helpInformation()).toContain('Start agent service');
    expect(state.loaded).toBe(false);
  });
  it('forwards option values verbatim to the selected implementation', async () => {
    await program().parseAsync(['start', '--machine-name', '--help'], { from: 'user' });
    expect(state.options).toEqual({ machineName: '--help' });
  });
  it('preserves nested aliases, arguments, options and parents', async () => {
    await program().parseAsync(['session', 'get', 'example', '--json'], { from: 'user' });
    expect(state.options).toEqual({ id: 'example', json: true, parent: 'session' });
  });
  it('dispatches help to the selected nested command tree', async () => {
    await expect(program().parseAsync(['help', 'session'], { from: 'user' })).rejects.toMatchObject(
      { code: 'commander.help' }
    );
    expect(state.help).toContain('show');
    expect(state.help).toContain('get');
  });
  it('retains unknown command errors', async () => {
    const command = program().configureOutput({ writeErr: () => {} });
    await expect(command.parseAsync(['missing'], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.unknownCommand',
    });
  });
});
