import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const stylexOptions = {
  unstable_moduleResolution: { type: 'commonJS' as const, rootDir: repoRoot },
  useCSSLayers: { prefix: 'stylex', before: ['theme', 'base'], after: ['components', 'utilities'] },
  // Vite web hosts emit index CSS; electron-vite emits main CSS. Both must
  // carry StyleX on first paint instead of falling back to a lazy chunk.
  cssInjectionTarget: (fileName: string) => /(^|\/)(?:index|main)(?:-[^/]+)?\.css$/.test(fileName),
};
