import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import postcss, { Input, type Declaration, type SourceMap, type SourceMapOptions } from 'postcss';
import { normalizePath, type Plugin } from 'vite';
import { legacyBindings, legacyDeclarations } from './src/style/legacy-declaration-profile';

const require = createRequire(import.meta.url);
// Babel's opaque AST is validated against the closed source grammar below.
// oxlint-disable-next-line typescript-eslint/no-explicit-any -- Only this Babel AST boundary is opaque; every accepted source node is checked below.
type Ast = any;
const babel = require('@babel/core') as {
  parseSync(source: string, options: Record<string, unknown>): Ast;
  transformSync(source: string, options: Record<string, unknown>): Ast;
  transformFromAstSync(ast: Ast, source: string, options: Record<string, unknown>): Ast;
};
const compiler = require('@stylexjs/babel-plugin');
const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const sourceFile = path.join(packageRoot, 'src/style/legacy-defaults.stylex.ts');
const cssFile = path.join(packageRoot, 'src/tailwind/index.css');
const sourceKey = normalizePath(sourceFile),
  cssKey = normalizePath(cssFile);
const baseOptions = { babelrc: false, configFile: false, parserOpts: { plugins: ['typescript'] } };
type CompiledDeclaration = { alias: string; declaration: Declaration; author: Ast };
export type CompiledLegacyDeclarations = {
  code: string;
  map: Omit<ReturnType<SourceMap['toJSON']>, 'version'> & { version: number };
  raw: string;
  filename: string;
  declarations: CompiledDeclaration[];
};
const member = (node: Ast, object: string, property: string) =>
  node?.type === 'MemberExpression' &&
  !node.computed &&
  node.object?.name === object &&
  node.property?.name === property;

/** Compile only the fixed flat declarations and approved class bindings. */
export function compileLegacyDeclarations(
  raw: string,
  filename: string
): CompiledLegacyDeclarations {
  const original = babel.parseSync(raw, { ...baseOptions, filename });
  const body: Ast[] = original.program.body;
  assert.equal(body.length, 3 + Object.keys(legacyBindings).length);
  const [importNode, guard, declaration, ...exports] = body;
  assert.equal(importNode.type, 'ImportDeclaration');
  assert.equal(importNode.source.value, '@stylexjs/stylex');
  assert.equal(importNode.specifiers.length, 1);
  assert.equal(importNode.specifiers[0].type, 'ImportNamespaceSpecifier');
  assert.equal(importNode.specifiers[0].local.name, 'stylex');
  assert.equal(guard.type, 'FunctionDeclaration');
  assert.equal(guard.id.name, 'legacyClass');
  assert(!guard.async && !guard.generator);
  assert.equal(guard.params.length, 1);
  assert.equal(guard.params[0].type, 'Identifier');
  assert.equal(guard.body.body.length, 1);
  const failure = guard.body.body[0];
  assert.equal(failure.type, 'ThrowStatement');
  assert.equal(failure.argument.type, 'NewExpression');
  assert.equal(failure.argument.callee.name, 'Error');
  assert.equal(failure.argument.arguments.length, 1);
  assert.equal(failure.argument.arguments[0].type, 'StringLiteral');
  assert.equal(declaration.type, 'VariableDeclaration');
  assert.equal(declaration.kind, 'const');
  assert.equal(declaration.declarations.length, 1);
  const local = declaration.declarations[0];
  assert.equal(local.id.name, 'styles');
  assert.equal(local.init.type, 'CallExpression');
  assert(member(local.init.callee, 'stylex', 'create'));
  assert.equal(local.init.arguments.length, 1);
  assert.equal(local.init.arguments[0].type, 'ObjectExpression');
  const properties: Ast[] = local.init.arguments[0].properties;
  assert.equal(properties.length, legacyDeclarations.length);
  const authors = new Map<string, Ast>();
  for (const [index, spec] of legacyDeclarations.entries()) {
    const property = properties[index];
    assert.equal(property.type, 'ObjectProperty');
    assert(!property.computed && property.key.name === spec.key);
    assert.equal(property.value.type, 'ObjectExpression');
    assert.equal(property.value.properties.length, 1);
    const value = property.value.properties[0];
    assert.equal(value.type, 'ObjectProperty');
    assert(!value.computed && value.key.name === spec.js);
    assert(['StringLiteral', 'NumericLiteral'].includes(value.value.type));
    if (value.value.type === 'NumericLiteral') assert(Number.isFinite(value.value.value));
    authors.set(spec.key, value);
  }
  const bindings = Object.entries(legacyBindings);
  for (const [index, [name, keys]] of bindings.entries()) {
    const statement = exports[index];
    assert.equal(statement.type, 'ExportNamedDeclaration');
    assert.equal(statement.declaration?.kind, 'const');
    assert.equal(statement.declaration.declarations.length, 1);
    const value = statement.declaration.declarations[0];
    assert.equal(value.id.name, name);
    assert.equal(value.init.type, 'CallExpression');
    assert.equal(value.init.callee.name, 'legacyClass');
    assert.equal(value.init.arguments.length, 1);
    const classes = value.init.arguments[0];
    assert.equal(classes.type, 'MemberExpression');
    assert(!classes.computed && classes.property.name === 'className');
    assert.equal(classes.object.type, 'CallExpression');
    assert(member(classes.object.callee, 'stylex', 'props'));
    assert.deepEqual(
      classes.object.arguments.map((n: Ast) => {
        assert.equal(n.type, 'MemberExpression');
        assert(!n.computed && n.object.name === 'styles');
        return n.property.name;
      }),
      keys
    );
  }
  const result = babel.transformSync(raw, {
    ...baseOptions,
    filename,
    ast: true,
    plugins: [
      [
        compiler,
        {
          dev: false,
          runtimeInjection: false,
          treeshakeCompensation: false,
          classNamePrefix: 'lodycompat',
        },
      ],
    ],
  });
  const metadata: Ast[] = result.metadata.stylex;
  assert.equal(metadata.length, legacyDeclarations.length);
  const atoms = new Map<string, string>();
  const declarations = metadata.map((tuple) => {
    assert(Array.isArray(tuple) && tuple.length === 3);
    const [id, css, priority] = tuple;
    assert.equal(typeof id, 'string');
    assert.deepEqual(Object.keys(css).sort(), ['ltr', 'rtl']);
    assert.equal(typeof css.ltr, 'string');
    assert.equal(css.rtl, null);
    assert(Number.isFinite(priority));
    const parsed = postcss.parse(css.ltr);
    assert.equal(parsed.nodes.length, 1);
    const rule = parsed.first;
    assert(rule?.type === 'rule' && rule.selector === '.' + id);
    assert.equal(rule.nodes.length, 1);
    const value = rule.first;
    assert(value?.type === 'decl' && !value.important);
    const spec = legacyDeclarations.find((s) => s.css === value.prop);
    assert(spec, 'Unexpected or non-flat declaration');
    assert(!atoms.has(spec.key));
    atoms.set(spec.key, id);
    return { alias: spec.alias, declaration: value, author: authors.get(spec.key) };
  });
  const folded: Ast[] = result.ast.program.body.filter(
    (n: Ast) => n.type === 'ExportNamedDeclaration'
  );
  assert.equal(folded.length, bindings.length);
  assert(
    result.ast.program.body.every(
      (n: Ast) =>
        n.type === 'ImportDeclaration' ||
        n.type === 'FunctionDeclaration' ||
        n.type === 'ExportNamedDeclaration'
    )
  );
  for (const [index, [name, keys]] of bindings.entries()) {
    const value = folded[index].declaration.declarations[0];
    assert.equal(value.id.name, name);
    assert.equal(value.init.type, 'CallExpression');
    assert.equal(value.init.callee.name, 'legacyClass');
    assert.equal(value.init.arguments.length, 1);
    let classes = value.init.arguments[0];
    if (classes.type === 'MemberExpression') {
      assert(!classes.computed && classes.property.name === 'className');
      assert.equal(classes.object.type, 'ObjectExpression');
      assert.equal(classes.object.properties.length, 1);
      const property = classes.object.properties[0];
      assert.equal(property.type, 'ObjectProperty');
      assert(!property.computed && property.key.name === 'className');
      classes = property.value;
    }
    assert.equal(classes.type, 'StringLiteral');
    assert.deepEqual(
      classes.value.split(' '),
      keys.map((k) => atoms.get(k))
    );
    value.init = {
      ...classes,
      value: keys.map((k) => legacyDeclarations.find((s) => s.key === k)!.alias).join(' '),
      loc: exports[index].declaration.declarations[0].init.loc,
    };
  }
  result.ast.program.body = folded;
  const output = babel.transformFromAstSync(result.ast, raw, {
    ...baseOptions,
    filename,
    sourceMaps: true,
    sourceFileName: normalizePath(filename),
  });
  return { code: output.code, map: output.map, raw, filename, declarations };
}

function comparable(property: string, value: string): string | number {
  if (property === 'opacity') {
    assert(
      /^(?:0|1|0?\.\d+|\d+(?:\.\d+)?%)$/.test(value),
      'Only static opacity numbers/percentages'
    );
    const n = value.endsWith('%') ? Number(value.slice(0, -1)) / 100 : Number(value);
    assert(n >= 0 && n <= 1);
    return n;
  }
  if (property === 'min-width') {
    assert(
      /^calc\(var\(--spacing\)\s*\*\s*0\)$/.test(value),
      'Keep the element-local calc-zero expression'
    );
    return 'calc(var(--spacing)*0)';
  }
  return value;
}

/** Replace real metadata nodes only after every original slot passes its oracle. */
export function replaceLegacyDeclarations(
  code: string,
  filename: string,
  compiled: CompiledLegacyDeclarations,
  previousMap?: SourceMapOptions['prev']
) {
  const ast = postcss.parse(code, { from: filename });
  const replacements = compiled.declarations.flatMap(({ alias, declaration, author }) => {
    const selector = '.' + alias.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    const found: postcss.Rule[] = [];
    ast.walkRules((rule) => {
      if (rule.selector === selector) found.push(rule);
    });
    // The locked v3 container plugin and Tailwind v4 each emit this same slot
    // in development; production optimization merges it. Replace both in place.
    assert(
      found.length === 1 || (alias === '@container' && found.length === 2),
      'Missing or ambiguous compatibility slot: ' + alias
    );
    return found.map((rule) => {
      const context = [];
      for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
        assert(p.type === 'atrule');
        context.unshift([p.name, p.params]);
      }
      assert.deepEqual(context, [['layer', 'utilities']]);
      assert.equal(rule.nodes.length, 1);
      const old = rule.first;
      assert(old?.type === 'decl' && !old.important);
      assert.equal(old.prop, declaration.prop);
      assert.equal(
        comparable(old.prop, old.value),
        comparable(declaration.prop, declaration.value),
        'Unequal compatibility declaration: ' + alias
      );
      const replacement = declaration.clone();
      replacement.raws = { ...old.raws };
      replacement.source = {
        input: new Input(compiled.raw, { from: compiled.filename }),
        start: {
          line: author.key.loc.start.line,
          column: author.key.loc.start.column + 1,
          offset: author.key.start,
        },
        end: {
          line: author.value.loc.end.line,
          column: author.value.loc.end.column + 1,
          offset: author.value.end,
        },
      };
      return { rule, old, replacement };
    });
  });
  for (const { rule, old, replacement } of replacements) {
    const slot = rule.parent!.nodes.indexOf(rule);
    old.replaceWith(replacement);
    assert.equal(old.parent, undefined);
    assert.equal(rule.parent!.nodes.indexOf(rule), slot);
  }
  return ast.toResult({
    from: filename,
    to: filename,
    map: { inline: false, annotation: false, prev: previousMap },
  });
}

/** Ordinary StyleX collection stays outside this closed legacy declaration path. */
export function legacyDeclarationBridge(options: { testOnlyBindings?: boolean } = {}): Plugin[] {
  assert(Object.keys(options).every((k) => k === 'testOnlyBindings'));
  let development = false,
    bindingSeen = false,
    cssSeen = false;
  return [
    {
      name: 'components-legacy-bindings',
      enforce: 'pre',
      buildStart() {
        bindingSeen = false;
        cssSeen = false;
      },
      load(id) {
        if (normalizePath(id.split('?')[0]) === sourceKey)
          assert(!id.includes('?'), 'Legacy bindings reject query/unsafe loaders');
      },
      transform(code, id) {
        if (normalizePath(id.split('?')[0]) !== sourceKey) return undefined;
        assert(!id.includes('?'));
        this.addWatchFile(sourceFile);
        bindingSeen = true;
        const compiled = compileLegacyDeclarations(code, sourceFile);
        return { code: compiled.code, map: compiled.map };
      },
      handleHotUpdate(ctx) {
        if (normalizePath(ctx.file) !== sourceKey) return undefined;
        return [
          ...new Set([...ctx.modules, ...(ctx.server.moduleGraph.getModulesByFile(cssKey) ?? [])]),
        ];
      },
      generateBundle() {
        if (!options.testOnlyBindings && bindingSeen)
          assert(cssSeen, 'Legacy bindings require their validated CSS entry');
      },
    },
    {
      name: 'components-legacy-declarations',
      configResolved(config) {
        development = config.command === 'serve';
      },
      transform(code, id) {
        if (normalizePath(id.split('?')[0]) !== cssKey) return undefined;
        assert(
          !id.includes('?') || id.endsWith('?direct'),
          'Unsupported compatibility stylesheet query'
        );
        this.addWatchFile(sourceFile);
        const result = replaceLegacyDeclarations(
          code,
          cssFile,
          compileLegacyDeclarations(fs.readFileSync(sourceFile, 'utf8'), sourceFile),
          this.getCombinedSourcemap()
        );
        cssSeen = true;
        const rawMap = result.map!.toJSON();
        assert.equal(Number(rawMap.version), 3);
        const map = { ...rawMap, version: 3 };
        const annotation = development
          ? '\n/*# sourceMappingURL=data:application/json;base64,' +
            Buffer.from(JSON.stringify(map)).toString('base64') +
            ' */'
          : '';
        return { code: result.css + annotation, map };
      },
    },
  ];
}
