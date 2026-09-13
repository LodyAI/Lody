import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  ACP_EXTENSION_DSH_CAPABILITY_SOURCE_VERSION,
  ACP_EXTENSION_DSH_QUERY_PATH_ENV,
  ACP_EXTENSION_DSH_SESSION_ROOT_ENV,
  DEEPSEEK_HARNESS_DEFAULT_SESSION_COMPRESSION,
  DEEPSEEK_HARNESS_NPX_PACKAGES,
  DEEPSEEK_HARNESS_PROFILE_FILENAMES,
  DEEPSEEK_HARNESS_PROFILE_NAME,
  DEEPSEEK_HARNESS_VERSION,
  createDeepSeekHarnessProfileFiles,
  type DeepSeekHarnessSessionCompression,
} from 'acp-extension-dsh/profile';

export { DEEPSEEK_HARNESS_VERSION, createDeepSeekHarnessProfileFiles };
export const DEEPSEEK_HARNESS_CAPABILITY_SOURCE_VERSION =
  ACP_EXTENSION_DSH_CAPABILITY_SOURCE_VERSION;
export const DEEPSEEK_HARNESS_HOME_ENV = 'DSH_HOME';

const RAW_SESSION_ARTIFACT = 'session.jsonl';
const ZSTD_SESSION_ARTIFACT = 'session.jsonl.zstd';

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

  return {
    command: 'npx',
    args: [
      '--prefer-offline',
      '-y',
      ...DEEPSEEK_HARNESS_NPX_PACKAGES.flatMap((packageName) => [
        '--package',
        `${packageName}@${DEEPSEEK_HARNESS_VERSION}`,
      ]),
      'dsh',
      '--profile',
      profileName,
      ...(options.extraArgs ?? []),
    ],
    env: {
      [DEEPSEEK_HARNESS_HOME_ENV]: rootDir,
      [ACP_EXTENSION_DSH_SESSION_ROOT_ENV]: sessionsRoot,
      [ACP_EXTENSION_DSH_QUERY_PATH_ENV]: join(sessionsRoot, 'session-query.db'),
    },
  };
}
