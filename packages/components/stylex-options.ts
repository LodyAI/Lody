import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stylexOptions } from '../ui/stylex-options';

/**
 * The StyleX options for the builds that compile this package's sources.
 *
 * The StyleX compiler resolves a `.stylex` import itself, and it does not read
 * the bundler's aliases — so `@/style/theme-colors.stylex`, which Vite
 * resolves, fails to resolve for the compiler and breaks the build. Telling
 * the compiler the alias lets the package's own source keep the `@/` form it
 * uses everywhere else.
 *
 * `/ROOT/` is the compiler's marker for a path relative to `rootDir`, which
 * `stylexOptions` already points at the repository root.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const componentsStylexOptions = {
  ...stylexOptions,
  aliases: {
    '@/*': '/ROOT/packages/components/src/*',
  },
  unstable_moduleResolution: {
    ...stylexOptions.unstable_moduleResolution,
    rootDir: repoRoot,
  },
};
