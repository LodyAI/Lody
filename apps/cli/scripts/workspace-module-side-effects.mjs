import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Applies each workspace package's own `sideEffects` declaration. Vite only attaches
 * it to bare-specifier resolutions, so modules a workspace package reaches through
 * relative imports otherwise count as side-effectful, and Rollup evaluates them in
 * every process that statically reaches any module of the package.
 */
export function workspaceModuleSideEffects(packagesDir) {
  const root = path.resolve(packagesDir) + path.sep;
  const declarations = new Map();
  const declarationOf = (name) => {
    if (!declarations.has(name)) {
      const directory = path.join(root, name);
      let declared;
      try {
        declared = JSON.parse(
          readFileSync(path.join(directory, 'package.json'), 'utf8')
        ).sideEffects;
      } catch {
        declared = undefined;
      }
      declarations.set(
        name,
        Array.isArray(declared)
          ? declared.some((entry) => entry.includes('*'))
            ? true
            : new Set(declared.map((entry) => path.resolve(directory, entry)))
          : declared !== false
      );
    }
    return declarations.get(name);
  };
  return (id) => {
    const file = id.split('?')[0];
    if (!file.startsWith(root) || file.includes(`${path.sep}node_modules${path.sep}`)) return true;
    const declared = declarationOf(file.slice(root.length).split(path.sep)[0]);
    return declared instanceof Set ? declared.has(file) : declared;
  };
}
