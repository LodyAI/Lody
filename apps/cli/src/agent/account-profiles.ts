import { randomUUID } from 'node:crypto';
import { v5 as uuidV5 } from 'uuid';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  SYSTEM_DEFAULT_ACCOUNT_PROFILE_ID,
  type AgentConfigCliType,
  type AccountProfileSummary,
} from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { scrubManagedClaudeAccountEnv } from './claude-env-conflict';

export { SYSTEM_DEFAULT_ACCOUNT_PROFILE_ID, type AccountProfileSummary } from '@lody/shared';
const ProfileSchema = z.object({
  accountProfileId: z.string().uuid(),
  label: z.string().trim().min(1).max(120),
});
export type AccountProfileInput = {
  cliType: AgentConfigCliType;
  agentType: string;
  accountProfileId?: string;
  env?: NodeJS.ProcessEnv;
  profilesRoot?: string;
};

export function isManagedAccountProfile(accountProfileId?: string): boolean {
  return accountProfileId !== undefined && accountProfileId !== SYSTEM_DEFAULT_ACCOUNT_PROFILE_ID;
}

type AccountLeaseInput = Pick<AccountProfileInput, 'cliType' | 'agentType' | 'accountProfileId'>;
type AccountLeaseState = { users: number; authenticating: boolean };
const accountLeases = new Map<string, AccountLeaseState>();

function acquireAccountLease(input: AccountLeaseInput, authentication: boolean): () => void {
  if (!isManagedAccountProfile(input.accountProfileId)) return () => {};
  if (
    input.cliType !== 'builtin' ||
    (input.agentType !== 'codex' && input.agentType !== 'claude')
  ) {
    throw new Error('Account profiles are supported only for built-in Codex and Claude');
  }
  const id = z.string().uuid().parse(input.accountProfileId);
  const key = `${input.agentType}:${id}`;
  const state = accountLeases.get(key) ?? { users: 0, authenticating: false };
  if (state.authenticating || (authentication && state.users > 0)) {
    throw new Error(
      'This account is in use or signing in. Wait for its processes to stop and retry.'
    );
  }
  if (authentication) state.authenticating = true;
  else state.users += 1;
  accountLeases.set(key, state);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (authentication) state.authenticating = false;
    else state.users -= 1;
    if (!state.authenticating && state.users === 0) accountLeases.delete(key);
  };
}

/** Process-wide across workspaces; held until the account's provider process exits. */
export function acquireAccountProfileUse(input: AccountLeaseInput): () => void {
  return acquireAccountLease(input, false);
}

export function acquireAccountProfileAuthentication(input: AccountLeaseInput): () => void {
  return acquireAccountLease(input, true);
}

function providerRoot(input: AccountProfileInput): string {
  if (
    input.cliType !== 'builtin' ||
    (input.agentType !== 'codex' && input.agentType !== 'claude')
  ) {
    throw new Error('Account profiles are supported only for built-in Codex and Claude');
  }
  return path.join(
    input.profilesRoot ?? path.join(getLodyDataDir(), 'agent-accounts'),
    input.agentType
  );
}

async function readProfile(input: AccountProfileInput) {
  await assertProfileRoots(input);
  const id = z.string().uuid().parse(input.accountProfileId);
  const directory = path.join(providerRoot(input), id);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Account profile directory is invalid');
  const profile = ProfileSchema.parse(
    JSON.parse(await fs.readFile(path.join(directory, 'profile.json'), 'utf8'))
  );
  if (profile.accountProfileId !== id) throw new Error('Account profile identity is invalid');
  const home = path.join(directory, 'home');
  const homeStat = await fs.lstat(home);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink())
    throw new Error('Account profile home is invalid');
  return { profile, home };
}

async function assertProfileRoots(input: AccountProfileInput): Promise<void> {
  const root = providerRoot(input);
  for (const directory of [path.dirname(root), root]) {
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Account profile root is invalid');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Resolve only Lody-owned metadata. Default never inspects or adopts native credentials. */
export async function resolveAccountProfileEnv(
  input: AccountProfileInput
): Promise<NodeJS.ProcessEnv> {
  const original = input.env ?? process.env;
  if (!isManagedAccountProfile(input.accountProfileId)) return original;
  const { home } = await readProfile(input);
  const env =
    input.agentType === 'claude' ? scrubManagedClaudeAccountEnv(original) : { ...original };
  env.LODY_ACCOUNT_PROFILE_ID = input.accountProfileId;
  // Managed subscription accounts must not silently use ambient API credentials.
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === (input.agentType === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'))
      delete env[key];
    if (
      input.agentType === 'codex' &&
      /^(OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|CODEX_AUTH_JSON|CODEX_CONFIG)$/.test(
        normalizedKey
      )
    )
      delete env[key];
  }
  if (input.agentType === 'codex') {
    env.CODEX_HOME = home;
    env.CODEX_CONFIG = JSON.stringify({ cli_auth_credentials_store: 'file' });
  } else env.CLAUDE_CONFIG_DIR = home;
  return env;
}

export function accountProfileAuthenticationArgs(
  input: Pick<AccountProfileInput, 'agentType' | 'accountProfileId'>,
  args: string[]
): string[] {
  return input.agentType === 'codex' && isManagedAccountProfile(input.accountProfileId)
    ? ['-c', 'cli_auth_credentials_store="file"', ...args]
    : args;
}

const creatingProfiles = new Map<string, Promise<AccountProfileSummary>>();

async function createProfileFiles(
  input: AccountProfileInput,
  profile: z.infer<typeof ProfileSchema>
): Promise<AccountProfileSummary> {
  const directory = path.join(providerRoot(input), profile.accountProfileId);
  await fs.mkdir(providerRoot(input), { recursive: true, mode: 0o700 });
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readProfile({ ...input, accountProfileId: profile.accountProfileId });
    if (existing.profile.label !== profile.label)
      throw new Error('Account creation request was already used with a different label', {
        cause: error,
      });
    return { ...existing.profile, status: 'unknown' };
  }
  await fs.mkdir(path.join(directory, 'home'), { mode: 0o700 });
  if (input.agentType === 'codex') {
    await fs.writeFile(
      path.join(directory, 'home', 'config.toml'),
      'cli_auth_credentials_store = "file"\n',
      { flag: 'wx', mode: 0o600 }
    );
  }
  await fs.writeFile(path.join(directory, 'profile.json'), JSON.stringify(profile), {
    flag: 'wx',
    mode: 0o600,
  });
  return { ...profile, status: 'unauthenticated' };
}

export async function createAccountProfile(
  input: AccountProfileInput & { label: string; operationId?: string }
): Promise<AccountProfileSummary> {
  await assertProfileRoots(input);
  const operationId =
    input.operationId === undefined
      ? undefined
      : z.string().min(1).max(1024).parse(input.operationId);
  const profile = ProfileSchema.parse({
    accountProfileId:
      operationId === undefined
        ? randomUUID()
        : uuidV5(`${input.agentType}:${operationId}`, uuidV5.URL),
    label: input.label,
  });
  const key = path.join(providerRoot(input), profile.accountProfileId);
  const pending = creatingProfiles.get(key);
  if (pending) {
    const result = await pending;
    if (result.label !== profile.label)
      throw new Error('Account creation request was already used with a different label');
    return result;
  }
  const creation = createProfileFiles(input, profile);
  creatingProfiles.set(key, creation);
  try {
    return await creation;
  } finally {
    creatingProfiles.delete(key);
  }
}

type ProbeOptions = Omit<
  import('./acp-authentication').ProbeBuiltinAuthenticationOptions,
  'accountProfileId'
>;
export async function validateAccountProfile(
  input: AccountProfileInput & ProbeOptions
): Promise<void> {
  const { probeBuiltinAuthentication } = await import('./acp-authentication');
  const result = await probeBuiltinAuthentication({ ...input, accountStatusOnly: true });
  if (result.status !== 'authenticated')
    throw new Error('Target account authentication could not be verified. Sign in and retry.');
}

export async function listAccountProfiles(
  input: AccountProfileInput & ProbeOptions
): Promise<AccountProfileSummary[]> {
  const root = providerRoot(input);
  await assertProfileRoots(input);
  const rows: AccountProfileSummary[] = [
    {
      accountProfileId: SYSTEM_DEFAULT_ACCOUNT_PROFILE_ID,
      label: 'System Default',
      status: 'unknown',
    },
  ];
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    entries = [];
  }
  for (const accountProfileId of entries.sort()) {
    if (!z.string().uuid().safeParse(accountProfileId).success) continue;
    try {
      const { profile } = await readProfile({ ...input, accountProfileId });
      rows.push({ ...profile, status: 'unknown' });
    } catch {
      rows.push({ accountProfileId, label: 'Unavailable account', status: 'error' });
    }
  }
  const { probeBuiltinAuthentication } = await import('./acp-authentication');
  const deadline = AbortSignal.timeout(15_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  for (const row of rows) {
    if (signal.aborted) break;
    if (row.status === 'error') continue;
    try {
      const result = await probeBuiltinAuthentication({
        ...input,
        accountProfileId: row.accountProfileId,
        accountStatusOnly: true,
        signal,
        statusProbeTimeoutMs: Math.min(input.statusProbeTimeoutMs ?? 5_000, 5_000),
      });
      row.status = result.status;
      if (result.status === 'authenticated') row.identity = result.identity;
    } catch {
      row.status = signal.aborted ? 'unknown' : 'error';
    }
  }
  return rows;
}
