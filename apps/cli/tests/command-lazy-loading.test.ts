import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ loaded: false, options: undefined as unknown }));
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
    sessionCommand: new Command('session').addCommand(
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
  it('retains unknown command errors', async () => {
    const command = program().configureOutput({ writeErr: () => {} });
    await expect(command.parseAsync(['missing'], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.unknownCommand',
    });
  });
});

it('keeps implementation imports dynamic in the emitted registration bundle', async () => {
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: ['src/commands/register.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    metafile: true,
    plugins: [
      {
        name: 'command-boundaries',
        setup(build) {
          build.onResolve({ filter: /^\.\// }, (args) =>
            args.kind === 'entry-point' ? undefined : { path: args.path, external: true }
          );
          build.onResolve({ filter: /^\.\.\/lib\/cli-platform$/ }, (args) => ({
            path: args.path,
            external: true,
          }));
        },
      },
    ],
    packages: 'external',
  });
  const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports);
  expect(imports.filter((entry) => entry.kind === 'dynamic-import')).toHaveLength(25);
  expect(
    imports.filter((entry) => entry.kind === 'import-statement').map((entry) => entry.path)
  ).toEqual(['commander', '../lib/cli-platform']);
});
