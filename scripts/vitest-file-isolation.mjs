import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Module mocks can survive between files when isolation is disabled. Keep those
// files in separate workers, including new mock suites added in the future.
export function withFileIsolation(root, options = {}) {
  const mocked = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (
        /\.test\.[cm]?[jt]sx?$/.test(entry.name) &&
        /\b(?:vi|vitest)\s*\.\s*(?:mock|doMock|unmock|doUnmock)\s*\(/.test(
          readFileSync(full, 'utf8')
        )
      ) {
        mocked.push(path.relative(root, full).replaceAll(path.sep, '/'));
      }
    }
  }
  visit(root);
  if (mocked.length === 0) return { ...options, isolate: false };
  return {
    ...options,
    projects: [
      {
        extends: true,
        test: {
          name: `${path.basename(root)}:shared`,
          isolate: false,
          exclude: [...(options.exclude ?? []), ...mocked],
        },
      },
      {
        extends: true,
        test: { name: `${path.basename(root)}:isolated`, isolate: true, include: mocked },
      },
    ],
  };
}
