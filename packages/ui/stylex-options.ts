import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const stylexOptions = {
  unstable_moduleResolution: { type: 'commonJS' as const, rootDir: repoRoot },
  useCSSLayers: { prefix: 'stylex', before: ['theme', 'base'], after: ['components', 'utilities'] },
  cssInjectionTarget: (fileName: string) => /(^|\/)index-[^/]+\.css$/.test(fileName),
};
