import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  accountProfileAuthenticationArgs,
  createAccountProfile,
  resolveAccountProfileEnv,
} from './account-profiles';

const roots: string[] = [];
async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-account-test-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('provider account isolation', () => {
  it('leaves legacy and explicit System Default environments identical without touching paths', async () => {
    const env = {
      CODEX_HOME: '/native/missing',
      CLAUDE_CONFIG_DIR: '/native/claude',
      ANTHROPIC_API_KEY: 'synthetic',
    };
    for (const accountProfileId of [undefined, 'system-default']) {
      expect(
        await resolveAccountProfileEnv({
          cliType: 'builtin',
          agentType: 'codex',
          accountProfileId,
          env,
          profilesRoot: '/does-not-exist',
        })
      ).toBe(env);
    }
  });

  it.each(['codex', 'claude'])(
    'authenticates %s accounts into empty independent homes without changing native state',
    async (agentType) => {
      const profilesRoot = await temporaryRoot();
      const input = { cliType: 'builtin' as const, agentType, profilesRoot };
      const a = await createAccountProfile({ ...input, label: 'Work' });
      const b = await createAccountProfile({ ...input, label: 'Personal' });
      const original = {
        CODEX_HOME: '/native',
        CLAUDE_CONFIG_DIR: '/native-claude',
        ANTHROPIC_API_KEY: 'synthetic',
        OPENAI_API_KEY: 'synthetic',
        PATH: '/bin',
      };
      const envA = await resolveAccountProfileEnv({
        ...input,
        accountProfileId: a.accountProfileId,
        env: original,
      });
      const envB = await resolveAccountProfileEnv({
        ...input,
        accountProfileId: b.accountProfileId,
        env: original,
      });
      const key = agentType === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
      expect(envA[key]).not.toBe(envB[key]);
      expect(await fs.readdir(envA[key] ?? '')).toEqual(
        agentType === 'codex' ? ['config.toml'] : []
      );
      expect(await fs.readdir(envB[key] ?? '')).toEqual(
        agentType === 'codex' ? ['config.toml'] : []
      );
      expect(envA[agentType === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY']).toBeUndefined();
      expect(original.CODEX_HOME).toBe('/native');
      expect(envA.PATH).toBe('/bin');
    }
  );

  it('rejects missing, malformed and wrong-provider profile bindings rather than falling back', async () => {
    const profilesRoot = await temporaryRoot();
    const input = { cliType: 'builtin' as const, agentType: 'codex', profilesRoot };
    const profile = await createAccountProfile({ ...input, label: 'Work' });
    await expect(
      resolveAccountProfileEnv({ ...input, accountProfileId: '../native' })
    ).rejects.toThrow();
    await expect(
      resolveAccountProfileEnv({
        ...input,
        agentType: 'claude',
        accountProfileId: profile.accountProfileId,
      })
    ).rejects.toThrow();
    await fs.writeFile(
      path.join(profilesRoot, 'codex', profile.accountProfileId, 'profile.json'),
      '{}'
    );
    await expect(
      resolveAccountProfileEnv({ ...input, accountProfileId: profile.accountProfileId })
    ).rejects.toThrow();
  });

  it('removes Windows case variants and pins managed Codex storage for every native login', async () => {
    const input = {
      cliType: 'builtin' as const,
      agentType: 'codex',
      profilesRoot: await temporaryRoot(),
    };
    const profile = await createAccountProfile({ ...input, label: 'Windows' });
    const selection = { ...input, accountProfileId: profile.accountProfileId };
    const env = await resolveAccountProfileEnv({
      ...selection,
      env: {
        codex_home: 'C:\\native',
        openai_api_key: 'synthetic',
        OpenAI_Base_Url: 'https://example.test',
        CODEX_CONFIG: '{"cli_auth_credentials_store":"keyring"}',
      },
    });
    expect(env.codex_home).toBeUndefined();
    expect(env.openai_api_key).toBeUndefined();
    expect(env.OpenAI_Base_Url).toBeUndefined();
    expect(JSON.parse(env.CODEX_CONFIG ?? '{}')).toEqual({ cli_auth_credentials_store: 'file' });
    expect(accountProfileAuthenticationArgs(selection, ['login'])).toEqual([
      '-c',
      'cli_auth_credentials_store="file"',
      'login',
    ]);
    const args = ['login'];
    expect(accountProfileAuthenticationArgs({ agentType: 'codex' }, args)).toBe(args);
  });

  it('refuses a redirected profile root without writing into its target', async () => {
    const root = await temporaryRoot();
    const target = path.join(root, 'native');
    await fs.mkdir(target);
    const profilesRoot = path.join(root, 'profiles');
    await fs.symlink(target, profilesRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(
      createAccountProfile({ cliType: 'builtin', agentType: 'codex', profilesRoot, label: 'Test' })
    ).rejects.toThrow('root is invalid');
    expect(await fs.readdir(target)).toEqual([]);
  });

  it('replays account creation without duplicating accounts or replacing existing credentials/config', async () => {
    const profilesRoot = await temporaryRoot();
    const input = {
      cliType: 'builtin' as const,
      agentType: 'codex',
      profilesRoot,
      label: 'Work',
      operationId: 'workspace/request',
    };
    const [first, concurrent] = await Promise.all([
      createAccountProfile(input),
      createAccountProfile(input),
    ]);
    expect(concurrent.accountProfileId).toBe(first.accountProfileId);
    const home = path.join(profilesRoot, 'codex', first.accountProfileId, 'home');
    await fs.writeFile(path.join(home, 'auth.json'), 'synthetic-auth-fixture');
    await fs.writeFile(path.join(home, 'config.toml'), 'synthetic-config-fixture');
    const replay = await createAccountProfile(input);
    expect(replay.accountProfileId).toBe(first.accountProfileId);
    expect(await fs.readdir(path.join(profilesRoot, 'codex'))).toEqual([first.accountProfileId]);
    expect(await fs.readFile(path.join(home, 'auth.json'), 'utf8')).toBe('synthetic-auth-fixture');
    expect(await fs.readFile(path.join(home, 'config.toml'), 'utf8')).toBe(
      'synthetic-config-fixture'
    );
    await expect(createAccountProfile({ ...input, label: 'Different' })).rejects.toThrow(
      'different label'
    );
  });
});
