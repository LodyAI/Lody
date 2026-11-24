import { Command } from 'commander';
import { registerCommands } from './register';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, onTestFinished, vi } from 'vitest';
import { compilePlugin } from '../plugins/plugin-build';
import { createPlugin } from './plugin-project';

test.each(['ui', 'sound', 'renderer', 'workflow'])(
  'doctor accepts %s scaffold without a workspace checkout or daemon',
  async (template) => {
    const cwd = await mkdtemp(join(tmpdir(), 'lody-create-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    const { path } = await createPlugin('my-plugin', template, cwd);
    const stage = await mkdtemp(join(cwd, 'build-'));
    const build = await compilePlugin({ sourceDir: path, stage });
    expect(build.manifest.id).toBe('my-plugin');
    const manifest = JSON.parse(await readFile(join(path, 'lody.plugin.json'), 'utf8'));
    const file = join(path, manifest.machine ?? manifest.client);
    await writeFile(file, 'my local changes');
    await expect(createPlugin('my-plugin', template, cwd)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(file, 'utf8')).toBe('my local changes');
    await unlink(file);
    const newStage = join(cwd, 'recheck');
    await mkdir(newStage);
    await expect(compilePlugin({ sourceDir: path, stage: newStage })).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
);

// Exercise Commander dispatch, replacing only the one-shot process exit boundary.
vi.mock('../lib/command-runtime', () => ({
  runOneShotCommand: async (_name: string, _options: unknown, action: () => Promise<void>) =>
    action(),
}));
test('registered CLI creates and checks source but rejects activation in an agent session', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'lody-cli-plugin-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  vi.stubEnv('LODY_AGENT_SESSION_ID', 'test-agent');
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const invoke = async (...args: string[]) => {
    const cmd = new Command('lody').enablePositionalOptions();
    registerCommands(cmd);
    await cmd.parseAsync(['plugin', ...args], { from: 'user' });
  };
  await invoke('create', 'sample', '--template', 'workflow');
  const path = join(cwd, 'sample');
  expect(await readFile(join(path, 'machine/index.ts'), 'utf8')).toContain('defineMachinePlugin');
  await expect(invoke('link', '--dev', path)).rejects.toThrow('interactive owner terminal');
});
