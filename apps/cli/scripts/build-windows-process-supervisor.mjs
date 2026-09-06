import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliRoot = fileURLToPath(new URL('../', import.meta.url));
const options = { arch: process.arch, outDir: path.join(cliRoot, 'dist') };
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!value || !['--arch', '--out-dir'].includes(flag)) {
    throw new Error(
      'Usage: build-windows-process-supervisor.mjs [--arch x64|arm64] [--out-dir DIR]'
    );
  }
  if (flag === '--arch') options.arch = value;
  else options.outDir = path.resolve(value);
}
if (process.platform !== 'win32')
  throw new Error('The Windows supervisor must be built on Windows.');
if (!['x64', 'arm64'].includes(options.arch))
  throw new Error('Supported Windows architectures: x64, arm64.');

function newestDirectory(root, predicate = () => true) {
  if (!fs.existsSync(root)) throw new Error(`Required build directory is missing: ${root}`);
  const directories = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)*$/.test(entry.name))
    .map((entry) => path.join(root, entry.name))
    .filter(predicate)
    .sort((left, right) =>
      path.basename(right).localeCompare(path.basename(left), undefined, { numeric: true })
    );
  if (!directories[0]) throw new Error(`No compatible build tools found in ${root}`);
  return directories[0];
}

const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
const discovery = spawnSync(
  vswhere,
  [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath',
  ],
  { encoding: 'utf8', windowsHide: true, timeout: 15_000 }
);
if (discovery.error || discovery.status !== 0 || !discovery.stdout.trim()) {
  throw new Error('Visual Studio C++ build tools were not found.');
}
const visualStudio = discovery.stdout.trim();
const toolset = newestDirectory(path.join(visualStudio, 'VC', 'Tools', 'MSVC'));
const host = process.arch === 'arm64' ? 'Hostarm64' : 'Hostx64';
const compiler = path.join(toolset, 'bin', host, options.arch, 'cl.exe');
if (!fs.existsSync(compiler))
  throw new Error(`Visual Studio C++ ${options.arch} compiler is not installed.`);
const sdkRoot = path.join(programFilesX86, 'Windows Kits', '10');
const sdkInclude = newestDirectory(
  path.join(sdkRoot, 'Include'),
  (directory) =>
    fs.existsSync(path.join(directory, 'um', 'Windows.h')) &&
    fs.existsSync(
      path.join(sdkRoot, 'Lib', path.basename(directory), 'um', options.arch, 'kernel32.lib')
    )
);
const sdkVersion = path.basename(sdkInclude);
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
const buildEnv = {
  ...process.env,
  [pathKey]: [
    path.dirname(compiler),
    path.join(sdkRoot, 'bin', sdkVersion, process.arch),
    process.env[pathKey] ?? '',
  ].join(path.delimiter),
  INCLUDE: [
    path.join(toolset, 'include'),
    ...['ucrt', 'shared', 'um'].map((part) => path.join(sdkInclude, part)),
  ].join(';'),
  LIB: [
    path.join(toolset, 'lib', options.arch),
    ...['ucrt', 'um'].map((part) => path.join(sdkRoot, 'Lib', sdkVersion, part, options.arch)),
  ].join(';'),
};
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-supervisor-build-'));
try {
  const binaryName = `windows-process-supervisor-win32-${options.arch}.exe`;
  const binary = path.join(scratch, binaryName);
  const result = spawnSync(
    compiler,
    [
      '/nologo',
      '/O2',
      '/MT',
      '/std:c++17',
      '/EHsc',
      '/W4',
      '/WX',
      '/utf-8',
      '/DUNICODE',
      '/D_UNICODE',
      '/D_WIN32_WINNT=0x0A00',
      `/Fe:${binary}`,
      `/Fo:${path.join(scratch, 'supervisor.obj')}`,
      path.join(cliRoot, 'native', 'windows-process-supervisor.cpp'),
      '/link',
      '/SUBSYSTEM:CONSOLE',
      '/DYNAMICBASE',
      '/NXCOMPAT',
    ],
    { cwd: scratch, env: buildEnv, encoding: 'utf8', windowsHide: true, timeout: 120_000 }
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Windows supervisor compilation failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`
    );
  }
  fs.mkdirSync(options.outDir, { recursive: true });
  fs.copyFileSync(binary, path.join(options.outDir, binaryName));
  console.log(`Built Windows process supervisor (${options.arch}).`);
} finally {
  const relative = path.relative(os.tmpdir(), scratch);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing cleanup outside the build scratch directory.');
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
