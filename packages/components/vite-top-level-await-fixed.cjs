'use strict';

// This is shared client build infrastructure, not a product-runtime fallback. The
// exact upstream version guard below deliberately turns dependency drift into
// a build error until this AST repair has been re-audited.

const path = require('node:path');
const { createRequire } = require('node:module');

const upstreamEntry = require.resolve('vite-plugin-top-level-await');
const upstreamRoot = path.resolve(path.dirname(upstreamEntry), '..');
const upstreamRequire = createRequire(path.join(upstreamRoot, 'package.json'));
const upstreamPackage = upstreamRequire('./package.json');

if (upstreamPackage.version !== '1.6.0') {
  throw new Error(
    `top-level-await-fixed is based on vite-plugin-top-level-await@1.6.0, ` +
      `but ${upstreamPackage.version} is installed. Re-audit the local fork before building.`
  );
}

const { rollup } = upstreamRequire('rollup');
const virtualModule = upstreamRequire('@rollup/plugin-virtual');
const virtual = virtualModule.default || virtualModule;
const SWC = upstreamRequire('./dist/swc');
const esbuildModule = upstreamRequire('./dist/esbuild');
const esbuild = esbuildModule.default || esbuildModule;
const { DEFAULT_OPTIONS } = upstreamRequire('./dist/options');
const { parseBundleAsts, parseBundleInfo } = upstreamRequire('./dist/bundle-info');
const { transformModule: upstreamTransformModule } = upstreamRequire('./dist/transform');

const DEFAULT_VITE_TARGET = ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'];

function getIdentifierValue(node) {
  return node && node.type === 'Identifier' ? node.value : undefined;
}

function collectExportedDeclarationNames(ast) {
  const exportMap = {};

  for (const item of ast.body) {
    switch (item.type) {
      case 'ExportDeclaration':
        if (
          item.declaration.type === 'FunctionDeclaration' ||
          item.declaration.type === 'ClassDeclaration'
        ) {
          const name = item.declaration.identifier.value;
          exportMap[name] = name;
        }
        break;
      case 'ExportDefaultDeclaration':
        if (
          (item.decl.type === 'FunctionExpression' || item.decl.type === 'ClassExpression') &&
          item.decl.identifier
        ) {
          exportMap.default = item.decl.identifier.value;
        }
        break;
      case 'ExportNamedDeclaration':
        if (!item.source) {
          for (const specifier of item.specifiers) {
            if (specifier.type === 'ExportSpecifier') {
              exportMap[(specifier.exported || specifier.orig).value] = specifier.orig.value;
            }
          }
        }
        break;
    }
  }

  const exportedNameSet = new Set(Object.values(exportMap));
  const functions = new Set();
  const classes = new Set();

  for (const item of ast.body) {
    if (
      item.type === 'FunctionDeclaration' &&
      item.identifier &&
      exportedNameSet.has(item.identifier.value)
    ) {
      functions.add(item.identifier.value);
    } else if (
      item.type === 'ClassDeclaration' &&
      item.identifier &&
      exportedNameSet.has(item.identifier.value)
    ) {
      classes.add(item.identifier.value);
    } else if (
      item.type === 'ExportDeclaration' &&
      item.declaration.identifier &&
      exportedNameSet.has(item.declaration.identifier.value)
    ) {
      if (item.declaration.type === 'FunctionDeclaration') {
        functions.add(item.declaration.identifier.value);
      } else if (item.declaration.type === 'ClassDeclaration') {
        classes.add(item.declaration.identifier.value);
      }
    } else if (
      item.type === 'ExportDefaultDeclaration' &&
      item.decl.identifier &&
      exportedNameSet.has(item.decl.identifier.value)
    ) {
      if (item.decl.type === 'FunctionExpression') {
        functions.add(item.decl.identifier.value);
      } else if (item.decl.type === 'ClassExpression') {
        classes.add(item.decl.identifier.value);
      }
    }
  }

  return { functions, classes };
}

function getMemberName(member) {
  if (!member) return undefined;
  const property = member.property;
  return property && property.type === 'Identifier' ? property.value : undefined;
}

function getWrapperStatementsFromPromiseExpression(expression) {
  if (!expression || expression.type !== 'CallExpression') return undefined;

  if (
    expression.callee.type === 'MemberExpression' &&
    getMemberName(expression.callee) === 'then'
  ) {
    const firstArg = expression.arguments[0] && expression.arguments[0].expression;
    return firstArg &&
      firstArg.type === 'ArrowFunctionExpression' &&
      firstArg.body &&
      firstArg.body.type === 'BlockStatement'
      ? firstArg.body.stmts
      : undefined;
  }

  if (
    expression.callee.type === 'ParenthesisExpression' &&
    expression.callee.expression.type === 'ArrowFunctionExpression' &&
    expression.callee.expression.body &&
    expression.callee.expression.body.type === 'BlockStatement'
  ) {
    return expression.callee.expression.body.stmts;
  }

  return undefined;
}

function getWrapperStatements(ast, promiseExportName) {
  for (const item of ast.body) {
    if (item.type === 'VariableDeclaration') {
      for (const declaration of item.declarations) {
        if (getIdentifierValue(declaration.id) === promiseExportName) {
          return getWrapperStatementsFromPromiseExpression(declaration.init);
        }
      }
    } else if (item.type === 'ExpressionStatement') {
      const statements = getWrapperStatementsFromPromiseExpression(item.expression);
      if (statements) return statements;
    }
  }
  return undefined;
}

function getAssignmentExpression(statement) {
  if (!statement || statement.type !== 'ExpressionStatement') return undefined;
  const expression = statement.expression;
  if (expression.type === 'AssignmentExpression') return expression;
  if (
    expression.type === 'ParenthesisExpression' &&
    expression.expression.type === 'AssignmentExpression'
  ) {
    return expression.expression;
  }
  return undefined;
}

function makeIdentifier(name) {
  return {
    type: 'Identifier',
    span: { start: 0, end: 0, ctxt: 0 },
    ctxt: 0,
    value: name,
    optional: false,
  };
}

function patchTransformedWrapper(ast, exportedDeclarations, options) {
  const statements = getWrapperStatements(ast, options.promiseExportName);
  if (!statements) return;

  const hoistedFunctionAssignments = [];
  const rest = [];

  for (const statement of statements) {
    const assignment = getAssignmentExpression(statement);
    const name = assignment ? getIdentifierValue(assignment.left) : undefined;

    if (
      name &&
      exportedDeclarations.classes.has(name) &&
      assignment.right.type === 'ClassExpression'
    ) {
      // Keep the class name available inside Monaco static initializers.
      assignment.right.identifier = assignment.right.identifier || makeIdentifier(name);
    }

    if (
      name &&
      exportedDeclarations.functions.has(name) &&
      assignment.right.type === 'FunctionExpression'
    ) {
      // Function declarations are hoisted before top-level execution. After
      // rewriting them to assignments, keep that behavior by assigning them
      // before the rest of the wrapped statements run.
      assignment.right.identifier = assignment.right.identifier || makeIdentifier(name);
      hoistedFunctionAssignments.push(statement);
      continue;
    }

    rest.push(statement);
  }

  statements.splice(0, statements.length, ...hoistedFunctionAssignments, ...rest);
}

function transformModuleFixed(code, ast, moduleName, bundleInfo, options) {
  const exportedDeclarations = collectExportedDeclarationNames(ast);
  const transformedAst = upstreamTransformModule(code, ast, moduleName, bundleInfo, options);
  patchTransformedWrapper(transformedAst, exportedDeclarations, options);
  return transformedAst;
}

function topLevelAwaitFixed(options) {
  const resolvedOptions = {
    ...DEFAULT_OPTIONS,
    ...(options || {}),
  };

  let isWorker = false;
  let isWorkerIifeRequested = false;
  let assetsDir = '';
  let buildTarget;
  let minify;

  const buildRawTarget = async (code) => {
    return (
      await esbuild.transform(code, {
        minify,
        target: buildTarget,
        format: 'esm',
      })
    ).code;
  };

  return {
    name: 'vite-plugin-top-level-await-fixed',
    enforce: 'post',
    outputOptions(outputOptions) {
      if (isWorker && outputOptions.format === 'iife') {
        outputOptions.format = 'es';
        isWorkerIifeRequested = true;
      }
    },
    config(config, env) {
      if (env.command === 'build') {
        if (config.worker) {
          isWorker = true;
        }
        config.build = config.build || {};
        buildTarget = config.build.target ?? DEFAULT_VITE_TARGET;
        config.build.target = 'esnext';
        minify = !!config.build.minify;
        assetsDir = config.build.assetsDir || 'assets';
      }
      if (env.command === 'serve') {
        if (config.optimizeDeps && config.optimizeDeps.esbuildOptions) {
          config.optimizeDeps.esbuildOptions.target = 'esnext';
        }
      }
    },
    async generateBundle(bundleOptions, bundle) {
      if (bundleOptions.format !== 'es') return;

      const bundleChunks = Object.fromEntries(
        Object.entries(bundle)
          .filter(([, item]) => item.type === 'chunk')
          .map(([key, item]) => [key, item.code])
      );
      const bundleAsts = await parseBundleAsts(bundleChunks);
      const bundleInfo = await parseBundleInfo(bundleAsts);

      // Upstream wraps chunks containing dynamic imports too, but propagates
      // initialization waits only from chunks containing real top-level await.
      // A static consumer must wait for either kind of wrapped export.
      const pending = Object.values(bundleInfo).filter((chunk) => chunk.transformNeeded);
      for (const chunk of pending) {
        for (const importer of chunk.importedBy) {
          const consumer = bundleInfo[importer];
          if (!consumer.transformNeeded) {
            consumer.transformNeeded = true;
            pending.push(consumer);
          }
        }
      }

      await Promise.all(
        Object.keys(bundleChunks).map(async (moduleName) => {
          if (!bundleInfo[moduleName].transformNeeded) {
            if (buildTarget !== 'esnext') {
              bundle[moduleName].code = await buildRawTarget(bundleChunks[moduleName]);
            }
            return;
          }

          const newAst = transformModuleFixed(
            bundleChunks[moduleName],
            bundleAsts[moduleName],
            moduleName,
            bundleInfo,
            resolvedOptions
          );
          let code = SWC.printSync(newAst, { minify }).code;
          if (buildTarget !== 'esnext') {
            code = await buildRawTarget(code);
          }
          bundle[moduleName].code = code;
        })
      );

      if (isWorker && isWorkerIifeRequested) {
        const chunkNames = Object.keys(bundle).filter((key) => bundle[key].type === 'chunk');
        const entry = chunkNames.find((key) => bundle[key].isEntry);
        if (!entry) {
          throw new Error(
            'Entry not found in worker bundle. Re-audit top-level-await-fixed for this output.'
          );
        }

        const newBuild = await rollup({
          input: entry,
          plugins: [virtual(Object.fromEntries(chunkNames.map((key) => [key, bundle[key].code])))],
        });
        const {
          output: [newEntry],
        } = await newBuild.generate({
          format: 'iife',
          entryFileNames: path.posix.join(assetsDir, '[name].js'),
        });

        newEntry.code = (
          await esbuild.transform(
            `self.document = { currentScript: { src: self.location.href } };\n${newEntry.code}`,
            {
              minify,
              target: buildTarget,
            }
          )
        ).code;

        for (const chunkName of chunkNames) {
          if (chunkName !== entry) delete bundle[chunkName];
        }
        bundle[entry] = newEntry;
      }
    },
  };
}

module.exports = topLevelAwaitFixed;
module.exports.default = topLevelAwaitFixed;
