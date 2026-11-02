import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Public protocol families whose ordinary content APIs reject encrypted workspaces.
// A new operation in one of these families requires admission without updating this list.
const legacyModules = new Set([
  'github',
  'githubPersonalAuthorization',
  'usage',
  'inbox',
  'promptShortcuts',
  'machines',
  'localProjects',
  'machineCredentials',
  'activity',
  'notifications',
]);
const legacyNames = new Set([
  'auth:transferWorkspaceOwnership',
  'auth:getWorkspaceUserProfileForCliToken',
  'deviceAuth:getWorkspaceBillingEntitlementForCliToken',
  'workspaceJoinRequests:getOwnerState',
  'workspaceJoinRequests:rotateLink',
  'workspaceJoinRequests:revokeLink',
  'workspaceJoinRequests:reviewRequest',
]);
const safeNames = new Map([
  [
    'auth:getUserById',
    'Display-only profile lookup returns null on denied membership/mode; never throws the mode refusal into render.',
  ],
  ['machinePairing:getRequest', 'Own request metadata only; no legacy content access.'],
  ['machinePairing:cancelRequest', 'Cancels own request; no legacy content access.'],
  [
    'machinePairing:claimFromDesktop',
    'Explicit pre-runtime pairing callback; backend validates its request workspace, and rejection is caught by the callback UI.',
  ],
  [
    'workspaceJoinRequests:getLinkPreview',
    'Public token preview; no content/runtime or legacy membership admission.',
  ],
  [
    'workspaceJoinRequests:submitRequest',
    'Public token request metadata; rejection stays in the submission form, before any content access.',
  ],
]);
// Exact non-React owners, not a blanket bypass for new APIs. See --inventory.
const exceptions = new Map([
  [
    'apps/cli/src/lib/github-token-manager.ts',
    new Map([
      ...[
        'github:getCredentialPolicyForCli',
        'github:getOperationAccessTokenByRepoNameForCli',
        'github:getAccessTokenByRepoNameForCli',
      ].map((name) => [
        name,
        'CLI GitHub token port: explicit workspace/token binding; protected machine composition exposes no ordinary GitHub capability; denied results are operation failures.',
      ]),
    ]),
  ],
  [
    'apps/cli/src/lib/session-export/workspace-usage.ts',
    new Map([
      ...[
        'usage:getWorkspaceUsageSummaryBundleFromCliToken',
        'usage:getWorkspaceUsageTimelineFromCliToken',
      ].map((name) => [
        name,
        'Explicit CLI export command; mode/token rejection fails the export, never renderer subscriptions or a success cache.',
      ]),
    ]),
  ],
  [
    'apps/cli/src/lib/usage/usage-tracking-service.ts',
    new Map([
      [
        'usage:upsertSessionUsageFromCli',
        'Ordinary CLI usage service only; encrypted machine composition has no usage capability. Rejections remain failed queued records.',
      ],
    ]),
  ],
  [
    'apps/cli/src/lib/workspace.ts',
    new Map([
      ...[
        'github:listWorkspaceRepositoriesForCliToken',
        'machines:upsertMachineRegistrationFromCliToken',
        'machines:canUseMachineFromCliToken',
        'machines:canDelegateMachineUseFromCliToken',
        'machines:canRequestMachineFromCliToken',
        'deviceAuth:getWorkspaceBillingEntitlementForCliToken',
      ].map((name) => [
        name,
        'Ordinary CLI workspace/account catalog and token validators; encrypted machine composition uses its separate device-authenticated port. Mode denial returns invalid or fails the requested command.',
      ]),
    ]),
  ],
  [
    'apps/cli/src/lib/notifications/notification-service.ts',
    new Map([
      ...[
        'notifications:notifySessionCompleted',
        'notifications:notifyPermissionRequested',
        'notifications:recordPermissionRequested',
        'notifications:resolvePermissionRequested',
        'notifications:syncLiveActivitySummary',
      ].map((name) => [
        name,
        'Ordinary CLI notification port; encrypted machine composition has no ordinary notification capability. Each failed operation is caught at the service boundary.',
      ]),
    ]),
  ],
  [
    'apps/cli/src/lib/cloud-cli-port.ts',
    new Map([
      [
        'auth:getWorkspaceUserProfileForCliToken',
        'Ordinary CLI profile lookup; encrypted machine composition has no account catalog capability. Backend mode rejection yields no profile.',
      ],
    ]),
  ],
  [
    'packages/components/src/providers/cloud-github-token-port.ts',
    new Map([
      ...[
        'github:getAccessTokenByRepoNameForClient',
        'github:getOperationAccessTokenByRepoNameForClient',
      ].map((name) => [
        name,
        'Imperative token owner rechecks the same live admission atoms before the first request and again after auth refresh, before retry.',
      ]),
    ]),
  ],
]);
const wrappers = new Set([
  'useLegacyWorkspaceQuery',
  'useLegacyWorkspaceMutation',
  'useLegacyWorkspaceAction',
]);
const isLegacy = (name) => legacyModules.has(name.split(':')[0]) || legacyNames.has(name);

function chain(node) {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node))
    return [...(chain(node.expression) ?? []), node.name.text];
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteral(node.argumentExpression)
  )
    return [...(chain(node.expression) ?? []), node.argumentExpression.text];
  return null;
}

/** Check real API references, including import aliases and computed property names. */
export function auditLegacyCloudSource(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const apiRoots = new Set();
  const guardedCalls = new Set();
  const apiNamespaces = new Map();
  const referenceFactories = new Set(['makeFunctionReference']);
  const factoryNamespaces = new Set();
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const module = node.moduleSpecifier.text;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      if (module === '@lody/cloud-api') apiNamespaces.set(bindings.name.text, 'api');
      if (module.endsWith('cloud-api-operations'))
        apiNamespaces.set(bindings.name.text, 'cloudOperations');
      if (module === 'convex/server') factoryNamespaces.add(bindings.name.text);
    }
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      const original = (binding.propertyName ?? binding.name).text;
      if (module === 'convex/server' && original === 'makeFunctionReference')
        referenceFactories.add(binding.name.text);
      if (
        (module === '@lody/cloud-api' && original === 'api') ||
        (module.endsWith('cloud-api-operations') && original === 'cloudOperations')
      )
        apiRoots.add(binding.name.text);
      if (module.endsWith('use-legacy-workspace-query') && wrappers.has(original))
        guardedCalls.add(binding.name.text);
    }
  }
  // Follow local aliases of the imported factory, including namespace properties.
  // Operations still belong in the registry; constructing a legacy reference in
  // a client is not an alternative to the shared admission wrappers.
  let addedAlias;
  do {
    addedAlias = false;
    for (const statement of ast.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const parts = chain(declaration.initializer);
        const factory =
          parts &&
          ((parts.length === 1 && referenceFactories.has(parts[0])) ||
            (parts.length === 2 &&
              factoryNamespaces.has(parts[0]) &&
              parts[1] === 'makeFunctionReference'));
        if (factory && !referenceFactories.has(declaration.name.text)) {
          referenceFactories.add(declaration.name.text);
          addedAlias = true;
        }
      }
    }
  } while (addedAlias);
  const rows = [];
  const errors = [];
  function record(node, name) {
    if (!isLegacy(name) && !safeNames.has(name)) return;
    const parent = node.parent;
    // Reading a protocol name for a synthetic adapter/diagnostic does not call it.
    if (
      (ts.isPropertyAccessExpression(parent) && parent.name.text === 'name') ||
      ts.isTypeQueryNode(parent)
    )
      return;
    const guarded =
      ts.isCallExpression(parent) &&
      parent.arguments[0] === node &&
      ts.isIdentifier(parent.expression) &&
      guardedCalls.has(parent.expression.text);
    const reason = safeNames.get(name) ?? exceptions.get(file)?.get(name);
    const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
    rows.push({
      file,
      line,
      name,
      protection: guarded ? 'shared admission wrapper' : (reason ?? 'UNGUARDED'),
    });
    if (!guarded && !reason)
      errors.push(
        `${file}:${line}: ${name} must use the shared legacy workspace admission wrapper`
      );
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) return;
    const parts = chain(node);
    const rest =
      parts &&
      (apiRoots.has(parts[0])
        ? parts.slice(1)
        : apiNamespaces.has(parts[0]) && parts[1] === apiNamespaces.get(parts[0])
          ? parts.slice(2)
          : null);
    if (rest?.length === 2) record(node, `${rest[0]}:${rest[1]}`);
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      !ts.isStringLiteral(node.argumentExpression)
    ) {
      const base = chain(node.expression);
      if (base && (apiRoots.has(base[0]) || apiNamespaces.has(base[0]))) {
        const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
        errors.push(
          `${file}:${line}: dynamic cloud API lookup bypasses the declared admission wrapper`
        );
      }
    }
    if (
      rest &&
      (rest.length === 0 || (rest.length === 1 && legacyModules.has(rest[0]))) &&
      !(
        (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node
      ) &&
      !ts.isTypeQueryNode(node.parent)
    ) {
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
      errors.push(
        `${file}:${line}: do not alias or destructure the legacy API root/module; pass the operation to its admission wrapper`
      );
    }
    if (ts.isStringLiteral(node) && isLegacy(node.text) && ts.isCallExpression(node.parent)) {
      const called = chain(node.parent.expression)?.at(-1);
      if (['query', 'mutation', 'action'].includes(called) || referenceFactories.has(called))
        record(node, node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { rows, errors };
}

export function auditLegacyCloudTree(root) {
  const files = [
    ...new Set(
      execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      })
        .trim()
        .split('\n')
    ),
  ];
  const rows = [],
    errors = [];
  for (const file of files) {
    if (
      !/^(apps|packages|site-docs)\//.test(file) ||
      !/\.[cm]?[jt]sx?$/.test(file) ||
      /\/(tests?|__tests__|stories|e2e)\//.test(file) ||
      /\.(test|spec|stories)\./.test(file) ||
      file.startsWith('packages/acp-extension-') ||
      file.startsWith('packages/cloud-api/') ||
      file === 'packages/components/src/lib/cloud-api-operations.ts'
    )
      continue;
    const result = auditLegacyCloudSource(file, fs.readFileSync(path.join(root, file), 'utf8'));
    rows.push(...result.rows);
    errors.push(...result.errors);
  }
  return { rows, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { rows, errors } = auditLegacyCloudTree(root);
  if (process.argv.includes('--inventory')) {
    console.log('| Client entry | APIs | Protection |\n| --- | --- | --- |');
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.file}|${row.protection}`;
      const group = groups.get(key) ?? { ...row, names: new Set() };
      group.names.add(row.name);
      groups.set(key, group);
    }
    for (const group of groups.values())
      console.log(
        `| ${group.file} | ${[...group.names]
          .sort()
          .map((name) => '`' + name + '`')
          .join(', ')} | ${group.protection} |`
      );
  }
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log(`Legacy cloud admission: ${rows.length} references checked.`);
}
