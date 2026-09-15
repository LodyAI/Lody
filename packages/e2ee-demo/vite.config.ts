import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    'process.env.LODY_E2EE_VERIFY_WORKERS': JSON.stringify('0'),
  },
  server: {
    host: '127.0.0.1',
    port: 5178,
    proxy: {
      '/healthz': 'http://127.0.0.1:8788',
      '/readyz': 'http://127.0.0.1:8788',
      '/v1': 'http://127.0.0.1:8788',
      '/ds': 'http://127.0.0.1:8788',
    },
  },
  build: {
    outDir: 'dist/ui',
    emptyOutDir: true,
  },
});
