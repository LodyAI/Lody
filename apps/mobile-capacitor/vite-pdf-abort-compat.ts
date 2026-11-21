import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const helperPath = fileURLToPath(new URL('./src/pdf-abort-signals.ts', import.meta.url));

/** Keep PDF document/interaction signals alive until their owning source aborts. */
export function pdfAbortCompatPlugin(): Plugin {
  return {
    name: 'lody-mobile-pdf-abort-compat',
    enforce: 'pre',
    config() {
      // Prebundling would hide PDF's member expressions from this transform.
      return { optimizeDeps: { exclude: ['pdfjs-dist'] } };
    },
    transform(code, id) {
      const filename = id.split('?')[0]!.replaceAll('\\', '/');
      if (!/\/pdfjs-dist\/legacy\/(?:build|web)\/[^/]+\.mjs$/.test(filename)) return null;
      if (!code.includes('AbortSignal')) return null;

      const stack: unknown[] = [this.parse(code)];
      const references: { start: number; end: number }[] = [];
      const identifiers = new Set<string>();
      while (stack.length) {
        const value = stack.pop();
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value)) {
          stack.push(...value);
          continue;
        }
        const node = value as Record<string, unknown>;
        if (node.type === 'Identifier') identifiers.add(node.name as string);
        if (node.type === 'MemberExpression') {
          const object = node.object as Record<string, unknown>;
          const property = node.property as Record<string, unknown>;
          if (
            object.type === 'Identifier' &&
            object.name === 'AbortSignal' &&
            ((!node.computed && property.type === 'Identifier' && property.name === 'any') ||
              (node.computed && property.type === 'Literal' && property.value === 'any'))
          ) {
            references.push({ start: node.start as number, end: node.end as number });
          }
        }
        stack.push(...Object.values(node));
      }
      if (references.length === 0) return null;

      let imported = '__lodyPdfAbortSignalAny';
      while (identifiers.has(imported)) imported += '_';
      let transformed = code;
      for (const { start, end } of references.sort((left, right) => right.start - left.start)) {
        transformed = transformed.slice(0, start) + imported + transformed.slice(end);
      }
      return {
        code: `import { pdfAbortSignalAny as ${imported} } from ${JSON.stringify(helperPath)};\n${transformed}`,
        map: null,
      };
    },
  };
}
