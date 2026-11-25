#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const componentCloudAdapterAllowlist = new Set([
  'packages/components/src/hooks/use-recoverable-convex-query.ts',
  'packages/components/src/lib/cloud-api-operations.ts',
  'packages/components/src/providers/authenticated-convex-provider.tsx',
  'packages/components/src/providers/cloud-github-token-port.ts',
  'packages/components/src/providers/cloud-platform-api.ts',
  'packages/components/src/providers/convex-provider.tsx',
  'packages/components/src/providers/recoverable-convex-better-auth-provider.tsx',
]);

const cliRuntimeRoots = [
  'apps/cli/src/lib/lody-fleet.ts',
  'apps/cli/src/lib/lody.ts',
  'apps/cli/src/lib/machine-runtime.ts',
  'apps/cli/src/lib/message-handler.ts',
  'apps/cli/src/lib/loro/',
  'apps/cli/src/preview/',
  'apps/cli/src/session/',
];

const cloudSdkPattern = /(?:from\s+|import\s*\()['"](?:@lody\/convex|convex\/(?:browser|react))['"]/gu;
const directConvexUseQueryPattern =
  /(?:import\s*\{[^}]*\buseQuery\b[^}]*\}\s*from\s*['"]convex\/react['"]|\bConvexReact\.useQuery\b)/gu;
const cloudEndpointPattern = /\bLODY_(?:AUTH_URL|AUTH_SITE_URL|SERVER_URL)\b/gu;
const localRendererIdentityPattern = /['"]local:renderer['"]/gu;

async function listSourceFiles() {
  const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: repoRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => /^(?:apps\/cli|packages\/components)\/src\/.*\.tsx?$/u.test(entry));
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

function collectMatches(file, content, pattern, rule) {
  const violations = [];
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    violations.push({
      file,
      line: lineNumberAt(content, match.index),
      rule,
      match: match[0],
    });
  }
  return violations;
}

async function main() {
  const files = await listSourceFiles();
  const violations = [];

  for (const file of files) {
    let content;
    try {
      content = await readFile(path.join(repoRoot, file), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (
      file.startsWith('packages/components/src/') &&
      !componentCloudAdapterAllowlist.has(file)
    ) {
      violations.push(
        ...collectMatches(
          file,
          content,
          cloudSdkPattern,
          'frontend feature code must use PlatformProvider cloud operations',
        ),
      );
    }

    if (file.startsWith('packages/components/src/')) {
      violations.push(
        ...collectMatches(
          file,
          content,
          directConvexUseQueryPattern,
          'raw convex/react useQuery throws backend errors into render; use watchQuery through use-recoverable-convex-query',
        ),
        ...collectMatches(
          file,
          content,
          localRendererIdentityPattern,
          'local renderer identity must come from the atomic CLI catalog snapshot',
        ),
      );
    }

    if (cliRuntimeRoots.some((root) => file === root || file.startsWith(root))) {
      violations.push(
        ...collectMatches(
          file,
          content,
          cloudSdkPattern,
          'CLI runtime must use the injected CloudPort',
        ),
        ...collectMatches(
          file,
          content,
          cloudEndpointPattern,
          'CLI runtime must not read cloud endpoint globals',
        ),
      );
    }
  }

  if (violations.length === 0) {
    console.log(`Platform boundary guard passed (${files.length} source files scanned).`);
    return;
  }

  console.error('Platform boundary guard failed:');
  for (const violation of violations) {
    console.error(
      `  ${violation.file}:${violation.line} ${violation.rule}: ${JSON.stringify(violation.match)}`,
    );
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
