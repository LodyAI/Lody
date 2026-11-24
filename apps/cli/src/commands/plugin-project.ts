import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pluginManifestSchema, pluginIdSchema } from '@lody/shared/plugins/manifest-schema';

const clients = {
  ui: `lody.screens.add({ id: 'home', title: 'Plugin home', Component: () => 'Hello from your plugin' });`,
  renderer: `lody.messages.renderBlock({ id: 'note', languages: ['plugin-note'], priority: 1, Component: () => 'Plugin note' });`,
  sound: `return lody.events.on('ui.message.submitted', async () => { const audio = new AudioContext(); try { const tone = audio.createOscillator(); tone.connect(audio.destination); tone.start(); tone.stop(audio.currentTime + 0.08); await new Promise<void>(done => tone.onended = () => done()); } finally { await audio.close(); } });`,
};
export async function createPlugin(id: string, template: string, cwd = process.cwd()) {
  pluginIdSchema.parse(id);
  if (template !== 'workflow' && !Object.hasOwn(clients, template))
    throw new Error('Choose ui, sound, renderer, or workflow');
  const side = template === 'workflow' ? 'machine' : 'client';
  const entry = `${side}/index.ts`;
  const manifest = pluginManifestSchema.parse({
    id,
    title: id,
    version: '0.1.0',
    sdk: '^1.0.0',
    [side]: entry,
  });
  const dir = resolve(cwd, id);
  await mkdir(dir);
  await mkdir(resolve(dir, side));
  const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
  const config = (node: boolean) => ({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      lib: node ? ['ES2022'] : ['ES2022', 'DOM'],
      types: node ? ['node'] : [],
      skipLibCheck: true,
    },
    include: [node ? 'machine' : 'client'],
  });
  const files = {
    'lody.plugin.json': json(manifest),
    'tsconfig.json': json(config(false)),
    'tsconfig.machine.json': json(config(true)),
    'package.json': json({
      name: id,
      private: true,
      type: 'module',
      dependencies: { '@lody/plugin-sdk': '*' },
      devDependencies: { typescript: '^5', '@types/node': '^22' },
    }),
    [entry]:
      template === 'workflow'
        ? `import { defineMachinePlugin } from '@lody/plugin-sdk/machine';\nexport default defineMachinePlugin(machine => { machine.onStart(() => console.info('Workflow started')); });\n`
        : `import { defineClientPlugin } from '@lody/plugin-sdk/client';\nexport default defineClientPlugin(lody => { ${clients[template as keyof typeof clients]} });\n`,
    'plugin.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\ntest('manifest points to the plugin entry', async () => { const manifest = JSON.parse(await readFile(new URL('./lody.plugin.json', import.meta.url))); assert.ok((await readFile(new URL(manifest.${side}, import.meta.url))).length); });\n`,
  };
  for (const [name, content] of Object.entries(files))
    await writeFile(resolve(dir, name), content, { flag: 'wx' });
  return { path: dir };
}
