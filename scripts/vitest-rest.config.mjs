import path from 'node:path';
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REST_PACKAGES = [
  'cli-supervisor',
  'code-review-helper',
  'e2ee-client',
  'e2ee-core',
  'e2ee-lab',
  'e2ee-machine-sharing',
  'iroh-native',
  'loro-streams-rpc',
  'platform',
  'shared',
  'turn-diff-store',
  'ui',
  'ignore',
];
const root = fileURLToPath(new URL('..', import.meta.url));
// CI imports the project inventory before installing dependencies. Resolve Vite
// only when Vitest actually evaluates the configuration factory.
export default async () => {
  const require = createRequire(
    realpathSync(path.join(root, 'packages/shared/node_modules/vitest/package.json'))
  );
  const { loadConfigFromFile, mergeConfig } = await import(require.resolve('vite'));
  return {
    test: {
      fsModuleCache: true,
      projects: (
        await Promise.all(
          REST_PACKAGES.map(async (name) => {
            const directory = path.join(root, 'packages', name);
            const configPath = path.join(directory, 'vitest.config.ts');
            const loaded = existsSync(configPath)
              ? (
                  await loadConfigFromFile(
                    { command: 'serve', mode: 'test' },
                    configPath,
                    directory
                  )
                ).config
              : {};
            const { projects, ...test } = loaded.test ?? {};
            const base = {
              ...loaded,
              test: {
                ...test,
                fsModuleCache: true,
                root: directory,
                name: `${name}:shared`,
                env: { ...test.env, LODY_TEST_PROJECT_ROOT: directory },
                setupFiles: [
                  path.join(root, 'scripts/vitest-project-cwd.mjs'),
                  ...(test.setupFiles ? [test.setupFiles].flat() : []),
                ],
                ...(name === 'e2ee-client' ? { sequence: { groupOrder: 1 } } : {}),
              },
            };
            // Inline projects cannot contain nested projects; keep the package's
            // shared and module-mocked groups as separate root projects.
            return projects
              ? projects.map((project) => mergeConfig(base, { test: project.test }))
              : [base];
          })
        )
      ).flat(),
    },
  };
};
