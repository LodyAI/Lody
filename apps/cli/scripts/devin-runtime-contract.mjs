import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Devin reads its sibling manifest with fs; inline it before relocating the adapter. */
export function devinRuntimeContractPlugin() {
  return {
    name: 'lody-devin-runtime-contract',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/acp-extension-devin/dist/manifest.js')) return null;
      const expression =
        'readFileSync(new URL("../runtime-manifest.json", import.meta.url), "utf8")';
      if (!code.includes(expression)) {
        throw new Error(
          'Devin manifest loader changed; update the bundled runtime contract transform.'
        );
      }
      const manifest = readFileSync(
        path.resolve(path.dirname(id), '../runtime-manifest.json'),
        'utf8'
      );
      JSON.parse(manifest);
      return { code: code.replace(expression, JSON.stringify(manifest)), map: null };
    },
  };
}
