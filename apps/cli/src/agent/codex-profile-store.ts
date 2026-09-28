import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  CodexAuthProfileSchema,
  assertManagedCodexProfileConfig,
  type AgentConfigMeta,
  type CodexAuthProfile,
} from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { SystemCodexCredentialVault, type CodexCredentialVault } from './codex-credential-vault';
import { execFile } from 'node:child_process';
import { resolveBuiltinAuthenticationProcessLaunch } from './setting';
import {
  registerCodexProfileProcess,
  reconcileCodexProfileProcesses,
  type CodexProfileProcessUsage,
} from './codex-profile-process-usage';

const ProfileRecordSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().min(1),
    machineId: z.string().min(1),
    configId: z.string().min(1),
    profile: CodexAuthProfileSchema,
    state: z.enum(['pending', 'ready', 'removed']),
    activeGeneration: z.uuid().optional(),
    generations: z.array(z.uuid()),
    credentialsRemoved: z.boolean().optional(),
  })
  .strict();

type ProfileRecord = z.infer<typeof ProfileRecordSchema>;
export type CodexProfileOwner = { workspaceId: string; machineId: string; configId: string };
export type ResolvedCodexProfile = CodexProfileOwner & { profile: CodexAuthProfile; home: string };

const identity = (owner: CodexProfileOwner) =>
  createHash('sha256')
    .update(JSON.stringify([owner.workspaceId, owner.machineId, owner.configId]))
    .digest('hex');

export class CodexProfileStore {
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly root = path.join(getLodyDataDir(), 'codex-profiles'),
    private readonly vault: CodexCredentialVault = new SystemCodexCredentialVault(),
    private readonly logout: (
      profile: ResolvedCodexProfile,
      lease: CodexProfileProcessUsage
    ) => Promise<void> = logoutNativeProfile
  ) {}

  private async directory(profileId: string): Promise<string> {
    z.uuid().parse(profileId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink())
      throw new Error('Codex profile storage cannot be a symbolic link');
    const root = await realpath(this.root);
    const directory = path.join(root, profileId);
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    if ((await lstat(directory)).isSymbolicLink() || (await realpath(directory)) !== directory) {
      throw new Error('Codex profile directory is not a private directory');
    }
    return directory;
  }

  private async read(directory: string): Promise<ProfileRecord | undefined> {
    const file = path.join(directory, 'profile.json');
    try {
      if ((await lstat(file)).isSymbolicLink()) throw new Error('Invalid Codex profile metadata');
      return ProfileRecordSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      // Raw JSON parser diagnostics may echo untrusted file contents.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Codex profile metadata could not be read');
    }
  }

  private async write(directory: string, record: ProfileRecord): Promise<void> {
    const temporary = path.join(directory, `profile-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await rename(temporary, path.join(directory, 'profile.json'));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private exclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.operations.set(id, current);
    void current
      .finally(() => {
        if (this.operations.get(id) === current) this.operations.delete(id);
      })
      .catch(() => {});
    return current;
  }

  private assertBinding(
    record: ProfileRecord,
    owner: CodexProfileOwner,
    profile: CodexAuthProfile
  ): void {
    if (
      identity(record) !== identity(owner) ||
      JSON.stringify(record.profile) !== JSON.stringify(profile)
    ) {
      throw new Error(
        'This Codex account belongs to a different provider connection; add a new provider'
      );
    }
    if (record.state === 'removed')
      throw new Error('This Codex account was removed; add a new provider');
  }

  async resolve(
    workspaceId: string,
    config: AgentConfigMeta,
    allowPending = false
  ): Promise<ResolvedCodexProfile | undefined> {
    if (!config.codexAuth) return undefined;
    assertManagedCodexProfileConfig(config);
    const profile = CodexAuthProfileSchema.parse(config.codexAuth);
    const owner = { workspaceId, machineId: config.machineId, configId: config.id };
    const directory = await this.directory(profile.profileId);
    const bindingPath = path.join(path.dirname(directory), `binding-${identity(owner)}.json`);
    try {
      await writeFile(bindingPath, JSON.stringify({ profileId: profile.profileId }), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if ((await lstat(bindingPath)).isSymbolicLink())
      throw new Error('Invalid Codex provider binding');
    const binding = z
      .object({ profileId: z.uuid() })
      .strict()
      .parse(JSON.parse(await readFile(bindingPath, 'utf8')));
    if (binding.profileId !== profile.profileId)
      throw new Error('This provider is bound to another Codex account; add a new provider');
    return await this.exclusive(profile.profileId, async () => {
      let record = await this.read(directory);
      if (!record) {
        if (!allowPending)
          throw new Error('This Codex account has not been authenticated on this machine');
        record = { version: 1, ...owner, profile, state: 'pending', generations: [] };
        await this.write(directory, record);
      }
      this.assertBinding(record, owner, profile);
      if (!allowPending && record.state !== 'ready')
        throw new Error('Authenticate this Codex account before starting a session');
      const home = path.join(directory, 'home');
      await mkdir(home, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      if ((await lstat(home)).isSymbolicLink() || (await realpath(home)) !== home)
        throw new Error('Invalid Codex account home');
      return { ...owner, profile, home };
    });
  }

  private credentialId(owner: CodexProfileOwner, profileId: string, generation: string): string {
    return `${identity(owner)}:${profileId}:${generation}`;
  }

  async isReady(resolved: ResolvedCodexProfile): Promise<boolean> {
    const record = await this.read(await this.directory(resolved.profile.profileId));
    if (!record) return false;
    this.assertBinding(record, resolved, resolved.profile);
    return record.state === 'ready';
  }

  async withApiKeyCandidate<T>(
    resolved: ResolvedCodexProfile,
    key: string,
    probe: (key: string) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (resolved.profile.mode !== 'api-key')
      throw new Error('This profile does not use an API key');
    if (!key.trim() || key.length > 8192 || /[\r\n]/.test(key) || key.includes('\0'))
      throw new Error('Enter a valid API key');
    return await this.exclusive(resolved.profile.profileId, async () => {
      const directory = await this.directory(resolved.profile.profileId);
      const record = await this.read(directory);
      if (!record) throw new Error('Codex account is unavailable');
      this.assertBinding(record, resolved, resolved.profile);
      signal?.throwIfAborted();
      const generation = randomUUID();
      const credentialId = this.credentialId(resolved, resolved.profile.profileId, generation);
      const candidate = { ...record, generations: [...record.generations, generation] };
      // Persist the candidate name before the vault write, so restart cleanup can find it.
      await this.write(directory, candidate);
      try {
        await this.vault.set(credentialId, key.trim());
        signal?.throwIfAborted();
        const result = await probe(key.trim());
        signal?.throwIfAborted();
        await this.write(directory, { ...candidate, activeGeneration: generation, state: 'ready' });
        return result;
      } catch (error) {
        await this.vault.delete(credentialId);
        await this.write(directory, record);
        throw error;
      }
    });
  }

  async apiKey(resolved: ResolvedCodexProfile): Promise<string> {
    const directory = await this.directory(resolved.profile.profileId);
    const record = await this.read(directory);
    if (!record) throw new Error('Codex account is unavailable');
    this.assertBinding(record, resolved, resolved.profile);
    if (record.state !== 'ready' || !record.activeGeneration)
      throw new Error('Authenticate this Codex account before starting a session');
    const key = await this.vault.get(
      this.credentialId(resolved, resolved.profile.profileId, record.activeGeneration)
    );
    if (!key) throw new Error('The saved API key is unavailable; authenticate this provider again');
    return key;
  }

  async markChatgptReady(resolved: ResolvedCodexProfile): Promise<void> {
    if (resolved.profile.mode !== 'chatgpt') throw new Error('This profile does not use ChatGPT');
    await this.exclusive(resolved.profile.profileId, async () => {
      const directory = await this.directory(resolved.profile.profileId);
      const record = await this.read(directory);
      if (!record) throw new Error('Codex account is unavailable');
      this.assertBinding(record, resolved, resolved.profile);
      await this.write(directory, { ...record, state: 'ready' });
    });
  }

  async remove(resolved: ResolvedCodexProfile): Promise<boolean> {
    return this.exclusive(resolved.profile.profileId, async () => {
      const directory = await this.directory(resolved.profile.profileId);
      const record = await this.read(directory);
      if (!record) return true;
      if (identity(record) !== identity(resolved)) throw new Error('Codex account owner mismatch');
      if (record.credentialsRemoved) return true;
      await this.write(directory, { ...record, state: 'removed' });
      if (record.profile.mode === 'chatgpt') {
        if (!(await reconcileCodexProfileProcesses(resolved))) return false;
        const lease = await registerCodexProfileProcess(resolved, {
          directNative: true,
          cleanup: true,
        });
        try {
          await this.logout(resolved, lease);
        } finally {
          await lease();
        }
      }
      for (const generation of record.generations) {
        await this.vault.delete(this.credentialId(record, record.profile.profileId, generation));
      }
      await this.write(directory, {
        ...record,
        state: 'removed',
        generations: [],
        activeGeneration: undefined,
        credentialsRemoved: true,
      });
      return true;
    });
  }

  async reconcileGenerations(resolved: ResolvedCodexProfile): Promise<void> {
    await this.exclusive(resolved.profile.profileId, async () => {
      const directory = await this.directory(resolved.profile.profileId);
      const record = await this.read(directory);
      if (!record || record.profile.mode !== 'api-key') return;
      this.assertBinding(record, resolved, resolved.profile);
      const unused = record.generations.filter(
        (generation) => generation !== record.activeGeneration
      );
      for (const generation of unused)
        await this.vault.delete(this.credentialId(record, record.profile.profileId, generation));
      if (unused.length)
        await this.write(directory, {
          ...record,
          generations: record.activeGeneration ? [record.activeGeneration] : [],
        });
    });
  }

  async list(workspaceId: string): Promise<ResolvedCodexProfile[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    );
    const profiles: ResolvedCodexProfile[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
      const directory = await this.directory(entry.name);
      const record = await this.read(directory);
      if (record?.workspaceId === workspaceId)
        profiles.push({ ...record, home: path.join(directory, 'home') });
    }
    return profiles;
  }
}

async function logoutNativeProfile(
  profile: ResolvedCodexProfile,
  lease: CodexProfileProcessUsage
): Promise<void> {
  const launch = await resolveBuiltinAuthenticationProcessLaunch({
    cliType: 'builtin',
    agentType: 'codex',
    action: 'status',
  });
  if (!launch) throw new Error('Codex account cleanup is unavailable');
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(CODEX_|OPENAI_|LODY_CODEX_|DYLD_|NODE_OPTIONS$|LD_PRELOAD$|LD_LIBRARY_PATH$)/i.test(key))
      delete env[key];
  env.CODEX_HOME = profile.home;
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      launch.command,
      ['-c', 'cli_auth_credentials_store="keyring"', 'logout'],
      { env, timeout: 20_000, windowsHide: true },
      (error) => {
        if (error) reject(new Error('Codex account cleanup could not complete'));
        else resolve();
      }
    );
    lease.recordNativePid(child.pid);
  });
}

let defaultStore: CodexProfileStore | undefined;
export const getCodexProfileStore = (): CodexProfileStore =>
  (defaultStore ??= new CodexProfileStore());
