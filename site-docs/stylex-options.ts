import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.dirname(fileURLToPath(import.meta.url));

export const siteStylexOptions = {
  unstable_moduleResolution: { type: 'commonJS' as const, rootDir: siteRoot },
  aliases: { '@site/*': '/ROOT/*' },
  cssInjectionTarget: (fileName: string) => /(^|\/)index-[^/]+\.css$/.test(fileName),
  useCSSLayers: {
    prefix: 'site-stylex',
    before: ['theme', 'base', 'components', 'utilities'],
    after: [],
  },
};
