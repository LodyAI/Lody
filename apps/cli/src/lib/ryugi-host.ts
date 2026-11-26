import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { getLocalControlSocketPath } from '@lody/shared/node/local-ipc';
import { resolveLodyBin } from '@/commands/daemon-shared';
import { getCliPlatformKind } from '@/lib/cli-platform';
import {
  getSeaContext,
  resolvePublishedManagedService,
  type SeaContext,
} from '@/lib/managed-daemon-release';

export const RYUGI_HOSTS_CONFIG_ENV = 'RYUGI_HOSTS_CONFIG';
export const LODY_DISABLE_RYUGI_HOST_ENV = 'LODY_DISABLE_RYUGI_HOST';
export const RYUGI_DEFAULT_TIMEOUT_MS = 15_000;

const RYUGI_BUILTIN_HOSTS = new Set(['codex', 'claude', 'pi', 'antigravity']);
const RYUGI_HOST_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const RYUGI_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RYUGI_SESSION_RE = /^[A-Za-z0-9_.:-]+$/;

export type RyugiCustomHostEntry = {
  env: string;
  agent: string;
  command: string[];
  timeoutMs: number;
};

export type ResolveRyugiHostsConfigOptions = {
  platform?: NodeJS.Platform;
  dataDir?: string;
  homeDir?: string;
  socketPath?: string;
  command?: readonly string[];
  execPath?: string;
  cliEntry?: string;
  electronRunAsNode?: boolean;
  seaContext?: SeaContext | null;
  publishedManagedService?: string | null;
  hostProcessEnv?: NodeJS.ProcessEnv;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDisabledFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

export function isValidRyugiHostName(name: string): boolean {
  return RYUGI_HOST_NAME_RE.test(name);
}

export function isValidRyugiEnvName(name: string): boolean {
  return RYUGI_ENV_NAME_RE.test(name);
}

export function isValidRyugiSession(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('..') &&
    RYUGI_SESSION_RE.test(value)
  );
}

function hasValidRyugiCommand(raw: unknown): boolean {
  if (typeof raw === 'string') return raw.trim().length > 0;
  if (Array.isArray(raw) && raw.length > 0) {
    return (
      raw.every((item) => typeof item === 'string') &&
      typeof raw[0] === 'string' &&
      raw[0].trim().length > 0
    );
  }
  return false;
}

export function getLodyRyugiHostsConfigPath(dataDir: string = getLodyDataDir()): string {
  return path.join(dataDir, 'ryugi', 'hosts.json');
}

export function resolveUserRyugiConfigPath(
  env: NodeJS.ProcessEnv,
  managedPath: string,
  homeDir: string = os.homedir()
): string {
  const configured = env[RYUGI_HOSTS_CONFIG_ENV]?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (resolved !== path.resolve(managedPath)) {
      return resolved;
    }
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const configBase = xdgConfigHome ? xdgConfigHome : path.join(homeDir, '.config');
  return path.join(configBase, 'ryugi', 'config.json');
}

export function resolveRyugiDeliveryCommand(
  options: ResolveRyugiHostsConfigOptions = {}
): string[] | undefined {
  if (options.command) {
    return options.command.length > 0 ? [...options.command] : undefined;
  }
  const socketPath = options.socketPath ?? getLocalControlSocketPath();
  const deliverArgs = [
    'session',
    'inbox',
    'deliver',
    '--source',
    'ryugi',
    ...(socketPath ? ['--socket', socketPath] : []),
  ];

  const sea = options.seaContext !== undefined ? options.seaContext : getSeaContext();
  if (sea) {
    const published =
      options.publishedManagedService !== undefined
        ? options.publishedManagedService
        : resolvePublishedManagedService(
            getCliPlatformKind() === 'cloud' ? 'lody-cloud' : 'lody-oss'
          );
    if (published && fs.existsSync(published)) {
      return [path.resolve(published), ...deliverArgs];
    }
    if (sea.capsulePath && fs.existsSync(sea.capsulePath)) {
      return [path.resolve(sea.capsulePath), ...deliverArgs];
    }
    return [path.resolve(sea.nodePath), path.resolve(sea.releaseDir, 'index.js'), ...deliverArgs];
  }

  const execPath = options.execPath ?? process.execPath;
  const rawEntry = options.cliEntry ?? resolveLodyBin();
  if (!execPath || !rawEntry || rawEntry === 'lody') {
    return undefined;
  }
  const cliEntry = path.resolve(rawEntry);
  const hostEnv = options.hostProcessEnv ?? process.env;
  const needsElectronRunAsNode =
    options.electronRunAsNode !== undefined
      ? options.electronRunAsNode
      : Boolean(hostEnv.ELECTRON_RUN_AS_NODE);

  if (needsElectronRunAsNode) {
    return ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', execPath, cliEntry, ...deliverArgs];
  }
  return [execPath, cliEntry, ...deliverArgs];
}

function readJsonObjectReadOnly(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeFileAtomicallyIfChanged(filePath: string, content: string): void {
  try {
    if (fs.readFileSync(filePath, 'utf8') === content) {
      return;
    }
  } catch {}

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(dir, `.hosts-${process.pid}-${randomUUID()}.tmp`);
  const fd = fs.openSync(tmpPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    throw error;
  }
}

export function prepareRyugiHostsConfigSync(
  sessionEnv: NodeJS.ProcessEnv,
  options: ResolveRyugiHostsConfigOptions = {}
): string | undefined {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return undefined;

  const hostProcessEnv = options.hostProcessEnv ?? process.env;
  if (
    isDisabledFlag(sessionEnv[LODY_DISABLE_RYUGI_HOST_ENV]) ||
    isDisabledFlag(hostProcessEnv[LODY_DISABLE_RYUGI_HOST_ENV])
  ) {
    return undefined;
  }

  const sessionId = sessionEnv.LODY_SESSION_ID;
  if (typeof sessionId !== 'string' || !isValidRyugiSession(sessionId)) {
    return undefined;
  }

  const command = resolveRyugiDeliveryCommand(options);
  if (!command) {
    return undefined;
  }

  const dataDir = options.dataDir ?? getLodyDataDir();
  const managedPath = getLodyRyugiHostsConfigPath(dataDir);
  const userConfigPath = resolveUserRyugiConfigPath(
    sessionEnv,
    managedPath,
    options.homeDir ?? os.homedir()
  );
  const userConfig = readJsonObjectReadOnly(userConfigPath);
  const userHosts = isPlainObject(userConfig.hosts) ? userConfig.hosts : {};

  for (const [hostName, entry] of Object.entries(userHosts)) {
    if (!isValidRyugiHostName(hostName) || RYUGI_BUILTIN_HOSTS.has(hostName)) continue;
    if (!isPlainObject(entry)) continue;
    if (typeof entry.env !== 'string' || !isValidRyugiEnvName(entry.env)) continue;
    if (!hasValidRyugiCommand(entry.command)) continue;
    if (hostName === 'lody') {
      return undefined;
    }
    const envValue = sessionEnv[entry.env];
    if (typeof envValue === 'string' && isValidRyugiSession(envValue)) {
      return undefined;
    }
  }

  const lodyHost: RyugiCustomHostEntry = {
    env: 'LODY_SESSION_ID',
    agent: 'Lody',
    command,
    timeoutMs: RYUGI_DEFAULT_TIMEOUT_MS,
  };

  const mergedConfig: Record<string, unknown> = {
    ...userConfig,
    hosts: {
      ...userHosts,
      lody: lodyHost,
    },
  };

  writeFileAtomicallyIfChanged(managedPath, `${JSON.stringify(mergedConfig, null, 2)}\n`);
  return managedPath;
}
