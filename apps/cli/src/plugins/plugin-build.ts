import { fileURLToPath } from 'node:url';
import { isBuiltin } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, sep } from 'node:path';
import { build } from 'esbuild';
import { z } from 'zod';
import { pluginManifestSchema } from '@lody/shared/plugins/manifest-schema';
import { computeClientDigest } from '@lody/shared/plugins/digest';

export async function compilePlugin(message: unknown) {
  const { sourceDir, stage } = z
    .object({ sourceDir: z.string(), stage: z.string() })
    .parse(message);
  const root = await realpath(sourceDir);
  const source = async (name: string) => {
    const file = await realpath(join(root, name));
    if (!file.startsWith(root + sep)) throw new Error(`Path leaves plugin: ${name}`);
    return file;
  };
  const manifest = pluginManifestSchema.parse(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await readFile(await source('lody.plugin.json'))
      )
    )
  );
  let machineDigest: string | undefined;
  for (const side of ['machine', 'client'] as const) {
    const entry = manifest[side];
    if (!entry) continue;
    const domMarker = `__lody_dom_${randomUUID().replaceAll('-', '')}`;
    const trustedRoots = new Set([root]);
    const result = await build({
      absWorkingDir: root,
      entryPoints: [await source(entry)],
      bundle: true,
      format: 'esm',
      platform: side === 'machine' ? 'node' : 'browser',
      target: side === 'machine' ? 'node22' : ['es2023', 'safari16.4'],
      define:
        side === 'machine'
          ? Object.fromEntries(
              ['window', 'document', 'globalThis.window', 'globalThis.document'].map((k) => [
                k,
                domMarker,
              ])
            )
          : {},

      plugins: [
        {
          name: 'lody-plugin-boundaries',
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, async (args) => {
              const forbidden =
                side === 'client'
                  ? isBuiltin(args.path) ||
                    args.path.startsWith('node:') ||
                    args.path === '@lody/plugin-sdk/machine'
                  : args.path === '@lody/plugin-sdk/client';
              if (forbidden) return { errors: [{ text: `${side} cannot import ${args.path}` }] };
              if (
                side === 'machine' &&
                [
                  '@lody/plugin-sdk',
                  '@lody/plugin-sdk/machine',
                  '@lody/plugin-sdk/manifest',
                  'zod',
                ].includes(args.path)
              ) {
                const entry = await realpath(fileURLToPath(import.meta.resolve(args.path)));
                let dir = dirname(entry);
                while (dir !== dirname(dir)) {
                  const name = await readFile(join(dir, 'package.json'), 'utf8').then(
                    (t) => JSON.parse(t).name,
                    () => undefined
                  );
                  if (name === (args.path === 'zod' ? 'zod' : '@lody/plugin-sdk')) break;
                  dir = dirname(dir);
                }
                if (dir === dirname(dir)) throw new Error(`Missing package for ${args.path}`);
                trustedRoots.add(dir);
                return { path: entry };
              }
              return undefined;
            });
            builder.onLoad({ filter: /.*/ }, async (args) => {
              const path = await realpath(args.path);
              if (!Array.from(trustedRoots).some((dir) => path.startsWith(dir + sep)))
                return { errors: [{ text: `Build input leaves plugin: ${args.path}` }] };
              return undefined;
            });
          },
        },
      ],
      jsx: 'automatic',
      logLevel: 'silent',
      write: false,
      outfile: `${side}.js`,
      external:
        side === 'client'
          ? [
              'react',
              'react/jsx-runtime',
              'zod',
              '@lody/ui',
              '@lody/plugin-sdk',
              '@lody/plugin-sdk/*',
            ]
          : [],
    });
    if (result.outputFiles.length !== 1)
      throw new Error('Declare styles and assets separately in the manifest');
    if (side === 'machine' && result.outputFiles[0]!.text.includes(domMarker))
      throw new Error('Machine plugin references a DOM global');
    const bytes = result.outputFiles[0]!.contents;
    manifest[side] = `${side}.js`;
    await writeFile(join(stage, manifest[side]), bytes, { flag: 'wx' });
    if (side === 'machine') machineDigest = createHash('sha256').update(bytes).digest('hex');
  }
  for (const p of new Set([
    ...(manifest.skills ?? []).map((name) => `skills/${name}/SKILL.md`),
    ...(manifest.agentRoles ?? []).map((r) => r.promptPath),
    ...(manifest.acpProviders ?? []).map((r) => r.entry),
    ...(manifest.mcpServers ?? []).map((r) => r.entry),
    ...(manifest.styles ?? []),
    ...(manifest.assets ?? []),
    ...(manifest.themes ?? []).flatMap((t) => ('path' in t ? [t.path] : [])),
  ])) {
    await mkdir(dirname(join(stage, p)), { recursive: true });
    await writeFile(join(stage, p), await readFile(await source(p)), { flag: 'wx' });
  }
  const clientDigest = await computeClientDigest(manifest, (p) => readFile(join(stage, p)));
  await writeFile(join(stage, 'lody.plugin.json'), JSON.stringify(manifest), { flag: 'wx' });
  await writeFile(join(stage, 'package.json'), '{"type":"module"}', { flag: 'wx' });
  return { manifest, clientDigest, machineDigest };
}
