import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  ACP_EXTENSION_DSH_CAPABILITY_SOURCE_VERSION,
  ACP_EXTENSION_DSH_QUERY_PATH_ENV,
  ACP_EXTENSION_DSH_SESSION_ROOT_ENV,
  DEEPSEEK_HARNESS_DEFAULT_SESSION_COMPRESSION,
  DEEPSEEK_HARNESS_PROFILE_FILENAMES,
  DEEPSEEK_HARNESS_PROFILE_NAME,
  DEEPSEEK_HARNESS_VERSION,
  createDeepSeekHarnessNpxSpecifiers,
  createDeepSeekHarnessProfileFiles,
  type DeepSeekHarnessSessionCompression,
} from 'acp-extension-dsh/profile';

export { DEEPSEEK_HARNESS_VERSION, createDeepSeekHarnessProfileFiles };
export const DEEPSEEK_HARNESS_CAPABILITY_SOURCE_VERSION =
  ACP_EXTENSION_DSH_CAPABILITY_SOURCE_VERSION;
export const DEEPSEEK_HARNESS_HOME_ENV = 'DSH_HOME';

const RAW_SESSION_ARTIFACT = 'session.jsonl';
const ZSTD_SESSION_ARTIFACT = 'session.jsonl.zstd';
const DSH_NODE_EXECUTABLE_ENV = 'LODY_DSH_NODE_EXECUTABLE';
const DSH_NODE_ARGS_ENV = 'LODY_DSH_NODE_ARGS';

/** Keep npx's logical command/argv for cache recovery; bypass its Windows shell shim only at spawn. */
export function resolveDeepSeekHarnessSpawn(options: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  workdir: string;
  platform?: NodeJS.Platform;
}): { command: string; args: string[] } {
  const { command, args, env, workdir } = options;
  if (
    (options.platform ?? process.platform) !== 'win32' ||
    command !== 'npx' ||
    !env[DSH_NODE_EXECUTABLE_ENV]
  ) {
    return { command, args };
  }

  const envValue = (name: string) => {
    const key = Object.keys(env)
      .sort()
      .find((candidate) => candidate.toLowerCase() === name);
    return key ? env[key] : undefined;
  };
  const directories = [workdir, ...(envValue('path') ?? '').split(';')];
  const extensions = (envValue('pathext') ?? '.COM;.EXE;.BAT;.CMD').split(';');
  for (const directory of directories) {
    if (!directory) continue;
    for (const extension of extensions) {
      const executable = resolve(
        workdir,
        directory.replace(/^"|"$/g, ''),
        `npx${extension.toLowerCase()}`
      );
      if (!existsSync(executable)) continue;
      // Native shims already avoid cmd.exe and its 8191-character limit.
      if (/\.(exe|com)$/i.test(extension)) return { command: executable, args };
      const entry = join(
        dirname(realpathSync(executable)),
        'node_modules',
        'npm',
        'bin',
        'npx-cli.js'
      );
      if (!existsSync(entry)) {
        throw new Error(
          `Cannot launch DeepSeek Harness without cmd.exe: npm's npx-cli.js is missing beside ${executable}. Install Node.js with npm and retry.`
        );
      }
      return { command: process.execPath, args: [entry, ...args] };
    }
  }
  throw new Error(
    'Cannot launch DeepSeek Harness: npx was not found on PATH. Install Node.js with npm and retry.'
  );
}

function encodeBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function createDeepSeekHarnessNodeLauncherArg(): string {
  const source = `
const { spawn } = require('node:child_process');
const executable = process.env.${DSH_NODE_EXECUTABLE_ENV};
const encodedArgs = process.env.${DSH_NODE_ARGS_ENV};
if (!executable || !encodedArgs) throw new Error('Missing Lody DSH runtime launch environment');
const args = JSON.parse(Buffer.from(encodedArgs, 'base64').toString('utf8'));
const child = spawn(executable, args, { env: process.env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code === null ? 1 : code;
});
`.trim();
  // Keep the eval payload opaque so npm can safely forward it as one argument.
  return `eval(Buffer.from('${encodeBase64(source)}','base64').toString('utf8'))`;
}

function createDeepSeekHarnessBootstrapSource(): string {
  return `
import { readFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const expectedVersion = ${JSON.stringify(DEEPSEEK_HARNESS_VERSION)};
let entryPath;

for (const binDir of (process.env.PATH ?? '').split(delimiter)) {
  if (!binDir) continue;
  const packageRoot = join(dirname(binDir), '@deepseek-ai', 'dsh');
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.version !== expectedVersion) continue;
    entryPath = join(packageRoot, 'lib', 'bin.js');
    await readFile(entryPath, 'utf8');
    break;
  } catch {}
}

if (!entryPath) {
  throw new Error(
    'The pinned @deepseek-ai/dsh@' + expectedVersion + ' entry was not found in the npx closure'
  );
}

const dshArgs = process.argv.slice(1);
process.argv = [process.execPath, entryPath, ...dshArgs];
const dsh = await import(pathToFileURL(entryPath).href);
if (typeof dsh.runCli !== 'function') {
  throw new Error('The pinned @deepseek-ai/dsh entry does not export runCli()');
}
await dsh.runCli();
`.trim();
}

export class DeepSeekHarnessMixedSessionCompressionError extends Error {
  readonly code = 'DSH_MIXED_SESSION_COMPRESSION';

  constructor(
    readonly sessionsRoot: string,
    readonly rawArtifact: string,
    readonly zstdArtifact: string
  ) {
    super(
      `DeepSeek Harness session root ${JSON.stringify(
        sessionsRoot
      )} contains both raw and Zstandard session artifacts (${JSON.stringify(
        rawArtifact
      )} and ${JSON.stringify(
        zstdArtifact
      )}). Lody left all session artifacts unchanged. Back up the root and migrate every session to one compression mode, or use a separate DSH_HOME before retrying.`
    );
    this.name = 'DeepSeekHarnessMixedSessionCompressionError';
  }
}

/** Match the official Harness home lookup: $DSH_HOME, then ~/.dsh. */
export function resolveDeepSeekHarnessHome(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir()
): string {
  const configuredHome = env[DEEPSEEK_HARNESS_HOME_ENV]?.trim();
  if (!configuredHome) return resolve(homeDir, '.dsh');
  if (configuredHome === '~') return resolve(homeDir);
  if (configuredHome.startsWith('~/') || configuredHome.startsWith('~\\')) {
    return resolve(homeDir, configuredHome.slice(2));
  }
  return resolve(configuredHome);
}

/**
 * Match the JSONL backend's one-encoding-per-root contract without opening or
 * modifying an artifact. Empty roots use upstream's zstd default; a legacy
 * Lody-only raw root keeps `none` so an upgrade never strands its sessions.
 */
export async function resolveDeepSeekHarnessSessionCompression(
  sessionsRoot: string
): Promise<DeepSeekHarnessSessionCompression> {
  let projectEntries;
  try {
    projectEntries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEEPSEEK_HARNESS_DEFAULT_SESSION_COMPRESSION;
    }
    throw error;
  }

  let rawArtifact: string | undefined;
  let zstdArtifact: string | undefined;
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const projectPath = join(sessionsRoot, projectEntry.name);
    const sessionEntries = await readdir(projectPath, { withFileTypes: true });
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionPath = join(projectPath, sessionEntry.name);
      const artifactEntries = await readdir(sessionPath, { withFileTypes: true });
      for (const artifactEntry of artifactEntries) {
        if (artifactEntry.name === RAW_SESSION_ARTIFACT) {
          rawArtifact ??= join(sessionPath, artifactEntry.name);
        } else if (artifactEntry.name === ZSTD_SESSION_ARTIFACT) {
          zstdArtifact ??= join(sessionPath, artifactEntry.name);
        }
      }
      if (rawArtifact && zstdArtifact) {
        throw new DeepSeekHarnessMixedSessionCompressionError(
          sessionsRoot,
          rawArtifact,
          zstdArtifact
        );
      }
    }
  }

  return rawArtifact ? 'none' : DEEPSEEK_HARNESS_DEFAULT_SESSION_COMPRESSION;
}

async function publishFileAtomically(filePath: string, contents: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    // On Windows rename cannot replace an existing destination. The profile
    // directory is content-addressed, so a racing writer can only have
    // published the same immutable files.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await rm(temporaryPath, { force: true });
  }
}

export async function resolveDeepSeekHarnessProcessLaunch(options: {
  adapterPath: string;
  rootDir?: string;
  extraArgs?: string[];
}) {
  const rootDir = options.rootDir ?? resolveDeepSeekHarnessHome();
  const sessionsRoot = join(rootDir, 'sessions');
  const presetRoot = join(dirname(options.adapterPath), 'deepseek-agent-presets');
  const sessionCompression = await resolveDeepSeekHarnessSessionCompression(sessionsRoot);
  const profileFiles = createDeepSeekHarnessProfileFiles({
    adapterPath: options.adapterPath,
    presetRoot,
    sessionCompression,
    reasoningEffort: 'max',
  });
  await mkdir(sessionsRoot, { recursive: true });
  // The adapter lives next to the installed CLI, so its absolute path can
  // change across app upgrades. Content-address the profile directory so
  // Windows never has to replace in-use files with a stale path.
  const fingerprint = createHash('sha256')
    .update(profileFiles.packageJson)
    .update(profileFiles.cordisYml)
    .update(profileFiles.cordisPatchYml)
    .update(profileFiles.pnpmWorkspaceYaml)
    .digest('hex')
    .slice(0, 12);
  const profileName = `${DEEPSEEK_HARNESS_PROFILE_NAME}-${fingerprint}`;
  const profileDir = join(rootDir, 'profiles', profileName);
  await mkdir(profileDir, { recursive: true });
  await Promise.all([
    publishFileAtomically(
      join(profileDir, DEEPSEEK_HARNESS_PROFILE_FILENAMES.packageJson),
      profileFiles.packageJson
    ),
    publishFileAtomically(
      join(profileDir, DEEPSEEK_HARNESS_PROFILE_FILENAMES.cordisYml),
      profileFiles.cordisYml
    ),
    publishFileAtomically(
      join(profileDir, DEEPSEEK_HARNESS_PROFILE_FILENAMES.cordisPatchYml),
      profileFiles.cordisPatchYml
    ),
    publishFileAtomically(
      join(profileDir, DEEPSEEK_HARNESS_PROFILE_FILENAMES.pnpmWorkspaceYaml),
      profileFiles.pnpmWorkspaceYaml
    ),
  ]);

  const dshNodeArgs = [
    '--input-type=module',
    '--eval',
    createDeepSeekHarnessBootstrapSource(),
    '--',
    '--profile',
    profileName,
    ...(options.extraArgs ?? []),
  ];

  return {
    command: 'npx',
    args: [
      '--prefer-offline',
      '-y',
      // Exact `name@version` specifiers: the Cordis-ecosystem packages version
      // independently of the Harness family and have no release at
      // `DEEPSEEK_HARNESS_VERSION`.
      ...createDeepSeekHarnessNpxSpecifiers().flatMap((specifier) => ['--package', specifier]),
      // npm exec does not shell-quote executable paths, so a minimal Node
      // launcher safely passes Lody Helper's space-containing path to spawn().
      // DSH itself still runs only under process.execPath.
      'node',
      '-e',
      createDeepSeekHarnessNodeLauncherArg(),
    ],
    env: {
      [DEEPSEEK_HARNESS_HOME_ENV]: rootDir,
      [ACP_EXTENSION_DSH_SESSION_ROOT_ENV]: sessionsRoot,
      [ACP_EXTENSION_DSH_QUERY_PATH_ENV]: join(sessionsRoot, 'session-query.db'),
      [DSH_NODE_EXECUTABLE_ENV]: process.execPath,
      [DSH_NODE_ARGS_ENV]: encodeBase64(JSON.stringify(dshNodeArgs)),
    },
  };
}
