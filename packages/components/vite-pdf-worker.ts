import type { Plugin } from 'vite';

/** PDF.js imports the Worker entry again when dedicated Workers are unavailable. */
export function preservePdfWorkerExports(): Plugin {
  return {
    name: 'lody-pdf-worker-exports',
    options(options) {
      const entries =
        typeof options.input === 'string' ? [options.input] : Object.values(options.input ?? {});
      if (!entries.some((entry) => /(?:^|[/\\])session-file-pdf\.worker\.js$/.test(entry)))
        return null;
      // Vite overwrites worker.rollupOptions.preserveEntrySignatures with false.
      // The Rollup options hook runs after that override.
      return { ...options, preserveEntrySignatures: 'strict' };
    },
  };
}
