import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import stylex from '@stylexjs/unplugin';
import { reviewStylexOptions } from './stylex-options';

export default defineConfig({
  plugins: [react(), tailwindcss(), stylex.vite(reviewStylexOptions)],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    format: 'es',
  },
});
