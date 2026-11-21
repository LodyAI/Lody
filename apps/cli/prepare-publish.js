#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cloudPackageDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(cloudPackageDir, '../..');
const publicCliDir = path.join(repoRoot, 'apps/cli');
const publicViewerDir = path.join(repoRoot, 'packages/code-review-viewer');
const publishRoot = path.join(cloudPackageDir, '.publish');

function readPackageJson(packageJsonPath) {
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
}

const DEPENDENCY_BLOCKS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const UNRESOLVABLE_PROTOCOL = /^(?:link|portal|file):/u;

function removeWorkspaceDependencies(packageJson) {
  let removedCount = 0;

  for (const block of DEPENDENCY_BLOCKS) {
    const dependencies = packageJson[block];
    if (!dependencies) continue;

    for (const [dependencyName, version] of Object.entries(dependencies)) {
      if (typeof version === 'string' && version.startsWith('workspace:')) {
        delete dependencies[dependencyName];
        removedCount += 1;
      }
    }

    if (Object.keys(dependencies).length === 0) {
      delete packageJson[block];
    }
  }

  return removedCount;
}

function assertPublishable(packageJson, label) {
  const offenders = [];

  for (const block of DEPENDENCY_BLOCKS) {
    for (const [dependencyName, version] of Object.entries(packageJson[block] ?? {})) {
      if (typeof version === 'string' && UNRESOLVABLE_PROTOCOL.test(version)) {
        offenders.push(`${block}.${dependencyName}: ${version}`);
      }
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `${label} declares dependencies that cannot be resolved outside this workspace:\n  ` +
        offenders.join('\n  ')
    );
  }
}

function copyRequired(sourcePath, destinationPath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Required publish artifact does not exist: ${sourcePath}`);
  }
  fs.cpSync(sourcePath, destinationPath, { recursive: true });
}

function copyOptional(sourcePath, destinationPath) {
  if (fs.existsSync(sourcePath)) {
    fs.cpSync(sourcePath, destinationPath, { recursive: true });
  }
}

const cloudPackage = readPackageJson(path.join(cloudPackageDir, 'package.json'));
const releaseVersion = cloudPackage.version;
if (typeof releaseVersion !== 'string' || releaseVersion.trim() === '') {
  throw new Error('apps/cli/package.json must contain a release version');
}

const viewerManifestPath = path.join(publicViewerDir, 'dist/manifest.generated.ts');
if (!fs.existsSync(viewerManifestPath)) {
  throw new Error('The code review viewer has not been built. Build lody first.');
}
const viewerManifest = fs.readFileSync(viewerManifestPath, 'utf8');
const expectedViewerVersion = `export const reviewViewerVersion = ${JSON.stringify(releaseVersion)};`;
if (!viewerManifest.includes(expectedViewerVersion)) {
  throw new Error(
    `The generated code review viewer does not target ${releaseVersion}. ` +
      'Build lody before preparing publish artifacts.'
  );
}

fs.rmSync(publishRoot, { recursive: true, force: true });

const cliPublishDir = path.join(publishRoot, 'lody');
fs.mkdirSync(cliPublishDir, { recursive: true });
const cliPackage = readPackageJson(path.join(publicCliDir, 'package.json'));
cliPackage.version = releaseVersion;
const removedCount = removeWorkspaceDependencies(cliPackage);
assertPublishable(cliPackage, 'lody');
fs.writeFileSync(
  path.join(cliPublishDir, 'package.json'),
  `${JSON.stringify(cliPackage, null, 2)}\n`
);
copyRequired(path.join(publicCliDir, 'dist'), path.join(cliPublishDir, 'dist'));
copyRequired(path.join(publicCliDir, 'README.md'), path.join(cliPublishDir, 'README.md'));
copyOptional(path.join(publicCliDir, 'LICENSE'), path.join(cliPublishDir, 'LICENSE'));

const viewerPublishDir = path.join(publishRoot, 'lody-code-review-viewer');
fs.mkdirSync(viewerPublishDir, { recursive: true });
const viewerPackage = readPackageJson(path.join(publicViewerDir, 'package.json'));
viewerPackage.version = releaseVersion;
removeWorkspaceDependencies(viewerPackage);
assertPublishable(viewerPackage, 'lody-code-review-viewer');
fs.writeFileSync(
  path.join(viewerPublishDir, 'package.json'),
  `${JSON.stringify(viewerPackage, null, 2)}\n`
);
copyRequired(
  path.join(publicViewerDir, 'standalone.html'),
  path.join(viewerPublishDir, 'standalone.html')
);
copyOptional(path.join(publicViewerDir, 'README.md'), path.join(viewerPublishDir, 'README.md'));
copyOptional(path.join(publicViewerDir, 'LICENSE'), path.join(viewerPublishDir, 'LICENSE'));

console.log(`Prepared immutable publish artifacts for Lody ${releaseVersion}.`);
console.log(`Removed ${removedCount} workspace-scoped CLI dependencies.`);
console.log('Publish with `pnpm publish`; only pnpm resolves the `catalog:` ranges.');
console.log(`CLI: ${cliPublishDir}`);
console.log(`Viewer: ${viewerPublishDir}`);
