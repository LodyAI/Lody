import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
const require = createRequire(import.meta.url)
function compile(source, url) {
  const ts = require('typescript')
  return ts.transpileModule(source, {
    compilerOptions: {
      module: url.endsWith('.cts') ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText
}

const RELATIVE = /^\.{1,2}(?:\/|$)/
const SOURCE_PARENT = /\.(?:[cm]?[jt]s|tsx)$/
const MISSING = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'])

// Preserve normal Node resolution first, including real .js files and package
// exports. Only source-relative paths get the bundler's TypeScript fallbacks.
export function resolve(specifier, context, nextResolve) {
  let original
  try {
    const resolved = nextResolve(specifier, context)
    if (resolved.url.endsWith('.json') && !context.importAttributes?.type)
      return { ...resolved, importAttributes: { ...context.importAttributes, type: 'json' } }
    return resolved
  } catch (error) {
    if (
      !MISSING.has(error?.code) ||
      !RELATIVE.test(specifier) ||
      !SOURCE_PARENT.test(context.parentURL ?? '')
    )
      throw error
    original = error
  }
  const candidates = /\.js$/.test(specifier)
    ? [specifier.slice(0, -3) + '.ts', specifier.slice(0, -3) + '.tsx']
    : /\.mjs$/.test(specifier)
      ? [specifier.slice(0, -4) + '.mts']
      : /\.cjs$/.test(specifier)
        ? [specifier.slice(0, -4) + '.cts']
        : /\.(?:[cm]?[jt]sx?|json|node|wasm|css)$/.test(specifier)
          ? []
          : ['.ts', '.tsx', '.mts', '.js', '/index.ts', '/index.tsx', '/index.js'].map(
              (suffix) => specifier.replace(/\/$/, '') + suffix
            )
  for (const candidate of candidates.filter((value) => RELATIVE.test(value))) {
    try {
      return nextResolve(candidate, context)
    } catch (error) {
      if (!MISSING.has(error?.code)) throw error
    }
  }
  throw original
}

// Use Node's native parser. Most sources are erasable; parameter properties
// and enums need its transform mode. JSX is intentionally unsupported here.
export function load(url, context, nextLoad) {
  if (!/\.(?:[cm]?ts|tsx)$/.test(url)) return nextLoad(url, context)
  const source = readFileSync(new URL(url), 'utf8')
  let output
  // Shared's legacy sources contain implicit type-only imports. Keep the
  // compiler's import elision at that package boundary; other packages use
  // native stripping unless they contain non-erasable syntax.
  if (url.includes('/packages/shared/src/')) output = compile(source, url)
  else
    try {
      output = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url })
    } catch (error) {
      if (error.code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') throw error
      try {
        output = stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url })
      } catch (transformError) {
        if (transformError.code !== 'ERR_INVALID_ARG_VALUE') throw transformError
        // Node 26 removed transform mode; only non-erasable modules need this.
        output = compile(source, url)
      }
    }
  return {
    format: url.endsWith('.cts') ? 'commonjs' : 'module',
    source: output,
    shortCircuit: true
  }
}
