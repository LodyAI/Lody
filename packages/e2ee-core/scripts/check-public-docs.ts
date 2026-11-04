/**
 * Fails when an export of a public entry (every `exports` key except
 * `./internal`), namespace export or service member has no JSDoc comment.
 * `--list` prints the entry-level surface instead.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  readonly exports: Record<string, string>;
};
const publicEntries = Object.entries(manifest.exports).filter(([name]) => name !== './internal');
const libraryProgram = ts.createProgram(
  publicEntries.map(([, file]) => path.join(root, file)),
  {
    strict: true,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    resolveJsonModule: true,
  }
);
const documented = (checker: ts.TypeChecker, symbol: ts.Symbol) => {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  if (symbol.getDocumentationComment(checker).length > 0) return true;
  if (
    symbol.declarations?.some(
      (declaration) =>
        ts.isNamespaceExport(declaration) &&
        ts.getJSDocCommentsAndTags(declaration.parent).length > 0
    )
  )
    return true;
  if (target.getDocumentationComment(checker).length > 0) return true;
  return (target.declarations ?? []).some(
    (declaration) =>
      ts.getJSDocCommentsAndTags(declaration).length > 0 ||
      // `export const X = Schema.Struct(...)` paired with `export type X`: either may carry the doc.
      (ts.isVariableDeclaration(declaration) &&
        ts.getJSDocCommentsAndTags(declaration.parent.parent).length > 0)
  );
};

/** Inspect actual TypeScript exports, including namespaces and inherited service members. */
export function inspectPublicEntries(
  program: ts.Program,
  entries: readonly (readonly [string, string])[]
) {
  const checker = program.getTypeChecker();
  const surface: { readonly entry: string; readonly names: readonly string[] }[] = [];
  const missing: string[] = [];
  const inspect = (symbol: ts.Symbol, name: string) => {
    if (!documented(checker, symbol)) missing.push(name);
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    if (target.flags & ts.SymbolFlags.Module) {
      for (const member of checker.getExportsOfModule(target))
        inspect(member, `${name}.${member.name}`);
    }
    if (!(target.flags & ts.SymbolFlags.Class)) return;
    // Context.Service exposes its contract through the instance's `Service`
    // type. Resolve it with the checker so aliases and inherited contracts
    // (CandidateProtector, for example) cannot bypass the check.
    const declaration = target.declarations?.[0];
    const service = checker.getDeclaredTypeOfSymbol(target).getProperty('Service');
    if (!service || !declaration) return;
    for (const member of checker.getPropertiesOfType(
      checker.getTypeOfSymbolAtLocation(service, declaration)
    )) {
      if (!documented(checker, member)) missing.push(`${name}.${member.name}`);
    }
  };
  for (const [name, file] of entries) {
    const source = program.getSourceFile(file);
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    if (!moduleSymbol) throw new Error(`cannot load ${file}`);
    const exports = checker
      .getExportsOfModule(moduleSymbol)
      .sort((a, b) => a.name.localeCompare(b.name));
    surface.push({
      entry: name === '.' ? '@lody/e2ee-core' : `@lody/e2ee-core/${name.slice(2)}`,
      names: exports.map((symbol) => symbol.name),
    });
    for (const symbol of exports) inspect(symbol, `${name}: ${symbol.name}`);
  }
  return { surface, missing };
}

/** Every public entry's exports, and exports or service members without JSDoc. */
export function inspectPublicSurface() {
  return inspectPublicEntries(
    libraryProgram,
    publicEntries.map(([name, file]) => [name, path.join(root, file)])
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { surface, missing } = inspectPublicSurface();
  if (process.argv.includes('--list'))
    for (const { entry, names } of surface)
      console.log(`\n${entry} (${names.length})\n  ${names.join('\n  ')}`);
  else if (missing.length) {
    console.error(
      `Public exports or service members without JSDoc (${missing.length}):\n  ${missing.join('\n  ')}`
    );
    process.exit(1);
  } else
    console.log(
      `All public exports, namespace exports and service members of ${publicEntries.length} entries are documented.`
    );
}
