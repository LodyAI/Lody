import { cp, readdir, readlink, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

export async function copyPiRuntimeFiles(build, packageDir) {
  for (const entry of ['dist', 'node_modules', 'package.json', 'LICENSE']) {
    await cp(path.join(build, entry), path.join(packageDir, entry), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  // Install metadata and CLI shims are not used by the direct ACP entrypoint.
  // Pruning can leave shims for removed development dependencies behind.
  for (const entry of ['.modules.yaml', '.pnpm-workspace-state-v1.json', '.bin']) {
    await rm(path.join(packageDir, 'node_modules', entry), { recursive: true, force: true });
  }
  const root = await realpath(packageDir);
  async function validate(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await validate(file);
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(file);
        if (path.isAbsolute(target)) throw new Error(`Absolute runtime symlink: ${file}`);
        const relative = path.relative(root, await realpath(file));
        if (
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          throw new Error(`Runtime symlink escapes package: ${file}`);
        }
      }
    }
  }
  await validate(root);
}
