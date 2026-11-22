import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { pdfAbortCompatPlugin } from './vite-pdf-abort-compat.ts';

const helperPath = fileURLToPath(new URL('./src/pdf-abort-signals.ts', import.meta.url));

function analyze(program) {
  const result = { exports: [], anyReferences: 0, helperImports: 0 };
  const stack = [program];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (node.type === 'ExportNamedDeclaration') {
      for (const specifier of node.specifiers) {
        result.exports.push(specifier.exported.name ?? specifier.exported.value);
      }
    }
    if (node.type === 'ImportDeclaration' && node.source.value === helperPath) {
      result.helperImports += 1;
    }
    if (
      node.type === 'MemberExpression' &&
      node.object.type === 'Identifier' &&
      node.object.name === 'AbortSignal' &&
      (node.computed ? node.property.value === 'any' : node.property.name === 'any')
    ) {
      result.anyReferences += 1;
    }
    stack.push(...Object.values(node));
  }
  return result;
}

void test('actual PDF modules retain their exports and route every any call through the owner helper', async () => {
  for (const entryName of ['build/pdf.mjs', 'web/pdf_viewer.mjs', 'build/pdf.worker.mjs']) {
    const entry = realpathSync(
      new URL(
        `../../packages/components/node_modules/pdfjs-dist/legacy/${entryName}`,
        import.meta.url
      )
    );
    let before;
    let after;
    const output = await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        pdfAbortCompatPlugin(),
        {
          name: 'inspect-pdf-compat-output',
          enforce: 'post',
          buildStart() {
            before = analyze(this.parse(readFileSync(entry, 'utf8')));
          },
          transform(code, id) {
            if (id === entry) after = analyze(this.parse(code));
          },
        },
      ],
      build: { write: false, minify: false, target: 'esnext', lib: { entry, formats: ['es'] } },
    });
    assert.ok(before && after, `the real ${entryName} must pass through the transform`);
    assert.equal(after.anyReferences, 0, entryName);
    assert.equal(after.helperImports, before.anyReferences > 0 ? 1 : 0, entryName);
    const chunks = output[0].output.filter((item) => item.type === 'chunk');
    const entryChunk = chunks.find((chunk) => chunk.isEntry);
    assert.deepEqual(entryChunk.exports.toSorted(), before.exports.toSorted(), entryName);
    assert.equal(
      chunks.some((chunk) => (chunk.modules[helperPath]?.renderedLength ?? 0) > 0),
      before.anyReferences > 0,
      `${entryName}: the helper must be in the final bundle exactly when needed`
    );
  }
});

async function runFixture(entry) {
  const fixture = `
    export const description = 'AbortSignal.any([source])';
    export const __lodyPdfAbortSignalAny = 'reserved local name';
    export function combine(signals) { return AbortSignal.any(signals); }
    export function computed(signals) { return AbortSignal['any'](signals); }
  `;
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      pdfAbortCompatPlugin(),
      {
        name: 'pdf-compat-fixture',
        resolveId(source) {
          return source === entry || source === helperPath ? source : null;
        },
        load(id) {
          if (id === entry) return fixture;
          if (id === helperPath) {
            return 'export function pdfAbortSignalAny(signals) { return { retained: true, signals }; }';
          }
          return null;
        },
      },
    ],
    build: { write: false, minify: false, lib: { entry, formats: ['es'] } },
  });
  const chunk = output[0].output.find((item) => item.type === 'chunk');
  return import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
}

void test('PDF member expressions use the helper while literals and existing bindings survive', async () => {
  const module = await runFixture('/virtual/node_modules/pdfjs-dist/legacy/build/fixture.mjs');
  const signals = [new AbortController().signal];
  assert.deepEqual(module.combine(signals), { retained: true, signals });
  assert.deepEqual(module.computed(signals), { retained: true, signals });
  assert.equal(module.description, 'AbortSignal.any([source])');
  assert.equal(module.__lodyPdfAbortSignalAny, 'reserved local name');
});

void test('other packages keep their original abort behavior', async () => {
  const module = await runFixture('/virtual/node_modules/streams-client/legacy/build/fixture.mjs');
  const source = new AbortController();
  const signal = module.combine([source.signal]);
  assert.ok(signal instanceof AbortSignal);
  source.abort('original cancellation');
  assert.equal(signal.reason, 'original cancellation');
});
