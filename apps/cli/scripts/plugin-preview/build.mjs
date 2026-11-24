import { build } from 'vite';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const components = path.resolve(here, '../../../../packages/components');
const fromComponents = createRequire(path.join(components, 'package.json'));
const stylex = fromComponents('@stylexjs/unplugin').default;
await build({
  configFile: false,
  esbuild: { jsx: 'automatic' },
  root: here,
  publicDir: false,
  resolve: {
    alias: {
      '@lody/ui': path.resolve(components, '../ui/src/index.ts'),
      ...Object.fromEntries(
        [
          'react-dom/client',
          'react/jsx-runtime',
          'react',
          'zod',
          '@lody/plugin-sdk/client',
          '@lody/plugin-sdk/manifest',
          '@lody/plugin-sdk',
        ].map((name) => [
          name,
          name.startsWith('@lody/plugin-sdk')
            ? path.join(
                components,
                'node_modules/@lody/plugin-sdk/dist',
                (name.split('/')[2] ?? 'index') + '.js'
              )
            : fromComponents.resolve(name),
        ])
      ),
    },
  },
  plugins: [
    stylex.rollup({
      unstable_moduleResolution: { type: 'commonJS', rootDir: path.resolve(here, '../../../..') },
      dev: false,
    }),
  ],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: path.join(here, 'generated'),
    lib: {
      entry: path.join(here, 'frame.jsx'),
      formats: ['iife'],
      name: 'Preview',
      fileName: () => 'frame.js',
      cssFileName: 'frame',
    },
    minify: true,
  },
});
