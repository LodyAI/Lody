import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import { z } from 'zod';
import {
  DshPluginPackageNameSchema,
  DshPluginsRequestSchema,
  type DshPlugin,
  type DshPluginsRequest,
} from '@lody/shared';
import { runCommand } from '@lody/shared/node/process';
import { withFileLock } from '@/utils/file-lock';
import { createDeepSeekHarnessNpxSpecifiers } from 'acp-extension-dsh/profile';
import {
  dshProfileLockName,
  publishFileAtomically,
  readDshProfileManifest,
  resolveDeepSeekHarnessSpawn,
} from './deepseek-harness-runtime';
import type { resolveDeepSeekHarnessProcessLaunch } from './deepseek-harness-runtime';

const pinnedPackages = new Set([
  'pnpm',
  ...createDeepSeekHarnessNpxSpecifiers().map((spec) => spec.slice(0, spec.lastIndexOf('@'))),
]);

export function dshPluginArguments(input: DshPluginsRequest): string[] {
  const request = DshPluginsRequestSchema.parse(input);
  if (request.action === 'list') return [];
  const name = request.package.replace(/@[^/]*$/, '');
  if (pinnedPackages.has(name) || name.startsWith('@lody/dsh-host-')) {
    throw new Error('This package belongs to the Lody runtime and cannot be changed here.');
  }
  switch (request.action) {
    case 'install':
      return ['add', '--save-exact', request.package];
    case 'update':
      return ['update', '--latest', request.package];
    case 'remove':
      return ['remove', request.package];
    default:
      throw new Error('Unsupported DSH plugin operation');
  }
}

export async function readDshPlugins(profileDir: string): Promise<DshPlugin[]> {
  const manifest = await readDshProfileManifest(profileDir);
  const plugins: DshPlugin[] = [];
  for (const [name, spec] of Object.entries({
    ...manifest.devDependencies,
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  })) {
    if (pinnedPackages.has(name) || name.startsWith('@lody/dsh-host-')) continue;
    DshPluginPackageNameSchema.parse(name);
    let version = spec;
    try {
      version = z
        .object({ version: z.string().max(300) })
        .parse(
          JSON.parse(await readFile(join(profileDir, 'node_modules', name, 'package.json'), 'utf8'))
        ).version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    plugins.push({ name, version, active: manifest.dsh.profile.bundles.includes(name) });
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

/** The application entry prepares the existing Promise-based launcher before this native unit. */
export const manageDshPlugins = Effect.fnUntraced(function* (
  request: DshPluginsRequest,
  launch: Awaited<ReturnType<typeof resolveDeepSeekHarnessProcessLaunch>>,
  hostEnv: NodeJS.ProcessEnv = process.env
) {
  const rootDir = launch.env.DSH_HOME;
  const profileDir = join(rootDir, 'profiles', 'lody-acp');
  return yield* withFileLock(
    dshProfileLockName(rootDir),
    Effect.gen(function* () {
      const plugins = yield* Effect.tryPromise(() => readDshPlugins(profileDir));
      if (request.action === 'list') return plugins;
      if (
        request.action !== 'install' &&
        !plugins.some((plugin) => plugin.name === request.package)
      ) {
        return yield* Effect.fail(new Error('The plugin is not installed in this Provider.'));
      }
      // Credentials from the saved Provider are never needed to install an npm package.
      const env: NodeJS.ProcessEnv = {};
      const allowedEnv = new Set([
        'PATH',
        'HOME',
        'USERPROFILE',
        'HOMEDRIVE',
        'HOMEPATH',
        'SYSTEMROOT',
        'TEMP',
        'TMP',
        'TMPDIR',
        'ELECTRON_RUN_AS_NODE',
      ]);
      for (const [key, value] of Object.entries(hostEnv)) {
        if (value !== undefined && allowedEnv.has(key.toUpperCase()))
          env[key.toUpperCase()] = value;
      }
      Object.assign(env, launch.env, {
        ELECTRON_RUN_AS_NODE: '1',
        npm_config_cache: join(rootDir, 'npm-cache'),
      });
      const command = resolveDeepSeekHarnessSpawn({ ...launch, env, workdir: profileDir });
      const snapshots = yield* Effect.tryPromise(() =>
        Promise.all(
          ['package.json', 'pnpm-lock.yaml'].map(async (file) => {
            const path = join(profileDir, file);
            try {
              return { path, text: await readFile(path, 'utf8') };
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              return { path, text: undefined };
            }
          })
        )
      );
      const restore = Effect.tryPromise(() =>
        Promise.all(
          snapshots.map(({ path, text }) =>
            text === undefined ? rm(path, { force: true }) : publishFileAtomically(path, text)
          )
        )
      );
      const result = yield* runCommand({
        ...command,
        env,
        cwd: profileDir,
        timeout: 240_000,
        maxOutputBytes: 2 * 1024 * 1024,
      }).pipe(
        // Typed process failure is delivered after process cleanup. A release defect
        // deliberately bypasses restoration: a still-running writer is not safe to overwrite.
        Effect.catch((error) => restore.pipe(Effect.andThen(Effect.fail(error))))
      );
      if (result.code !== 0) {
        yield* restore;
        return yield* Effect.fail(
          new Error(
            `DSH plugin ${request.action} failed (exit ${result.code ?? 'unknown'}). Check the plugin installation logs in ${join(profileDir, '.plugin-manager', 'logs')}. The package manager may need a retry to repair a partial install.`
          )
        );
      }
      return yield* Effect.tryPromise(() => readDshPlugins(profileDir));
    }),
    { locksDir: join(rootDir, 'lody-locks'), timeout: 300_000 }
  );
});
