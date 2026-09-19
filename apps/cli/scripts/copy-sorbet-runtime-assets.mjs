import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sorbetRoot = path.resolve(cliRoot, '../../packages/sorbet');
const sandboxPackage = path.join(
  sorbetRoot,
  'packages/node-agent/node_modules/@anthropic-ai/sandbox-runtime'
);
const sourceVendor = fs.realpathSync(path.join(sandboxPackage, 'vendor'));
export function copySorbetRuntimeAssets(outputRoot = path.join(cliRoot, 'dist')) {
  const runtimeRoot = path.join(outputRoot, 'sorbet');
  const destinationVendor = path.join(outputRoot, 'vendor');

  if (!fs.existsSync(path.join(runtimeRoot, 'dist/stdio-cli.js'))) {
    throw new Error(
      'Bundled Sorbet ACP entry is missing. Run the CLI bundle before copying assets.'
    );
  }
  if (!fs.existsSync(path.join(runtimeRoot, 'dist/filesystem-worker.js'))) {
    throw new Error('Bundled Sorbet filesystem worker is missing.');
  }
  if (!fs.existsSync(path.join(runtimeRoot, 'dist/provider-control.js'))) {
    throw new Error('Bundled Sorbet Provider Center control entry is missing.');
  }

  fs.rmSync(destinationVendor, { recursive: true, force: true });
  fs.cpSync(sourceVendor, destinationVendor, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeRoot, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`
  );

  for (const relativePath of [
    'vendor/seccomp/x64/apply-seccomp',
    'vendor/seccomp/arm64/apply-seccomp',
  ]) {
    fs.chmodSync(path.join(outputRoot, relativePath), 0o755);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  copySorbetRuntimeAssets();
}
