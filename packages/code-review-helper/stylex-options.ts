import { fileURLToPath } from 'node:url';

/** Shared by the development renderer, Storybook and the single-file viewer. */
export const reviewStylexOptions = {
  unstable_moduleResolution: {
    type: 'commonJS' as const,
    rootDir: fileURLToPath(new URL('.', import.meta.url)),
  },
  useCSSLayers: {
    prefix: 'stylex',
    before: ['theme', 'base'],
    after: ['components', 'utilities'],
  },
};
