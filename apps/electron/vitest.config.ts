import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    dedupe: ['react', 'react-dom', 'jotai'],
    alias: {
      '@lody/components': resolve(__dirname, '../../packages/components/src'),
      '@/': `${resolve(__dirname, '../../packages/components/src')}/`
    }
  },
  test: { environment: 'jsdom', include: ['src/renderer/**/*.test.tsx'] }
})
