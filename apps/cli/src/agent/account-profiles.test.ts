import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeBuiltinAuthentication } from './acp-authentication';
import type { Logger } from '@/utils/logger';
import {
  accountProfileAuthenticationArgs,
  createAccountProfile,
  resolveAccountProfileEnv,
  validateAccountProfile,
} from './account-profiles';

vi.mock('./acp-authentication', () => ({ probeBuiltinAuthentication: vi.fn() }));
const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => logger,
  close: async () => {},
};

const roots: string[] = [];
async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-account-test-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('account handoff validation', () => {
  it.each([undefined, 'system-default'])(
    'accepts the resolved environment-authentication reason only for System Default (%s)',
    async (accountProfileId) => {
      vi.mocked(probeBuiltinAuthentication).mockResolvedValue({
        status: 'unknown',
        reason: 'environment-authentication',
      });
      await expect(
        validateAccountProfile({
          cliType: 'builtin',
          agentType: 'claude',
          accountProfileId,
          logger,
        })
      ).resolves.toBeUndefined();
    }
  );

  it.each(['unknown', 'environment-authentication', 'unauthenticated'] as const)(
    'rejects managed accounts with %s status even when ambient API authentication is configured',
    async (status) => {
      vi.mocked(probeBuiltinAuthentication).mockResolvedValue(
        status === 'unauthenticated'
          ? { status: 'unauthenticated', authMethods: [] }
          : status === 'environment-authentication'
            ? { status: 'unknown', reason: 'environment-authentication' }
            : { status: 'unknown' }
      );
      await expect(
        validateAccountProfile({
          cliType: 'builtin',
          agentType: 'claude',
          accountProfileId: '00000000-0000-4000-8000-000000000001',
          env: { ANTHROPIC_API_KEY: 'synthetic-test-value' },
          logger,
        })
      ).rejects.toThrow('authentication could not be verified');
    }
  );

  it('rejects unexplained unknown System Default status despite raw input credentials', async () => {
    vi.mocked(probeBuiltinAuthentication).mockResolvedValue({ status: 'unknown' });
    await expect(
      validateAccountProfile({
        cliType: 'builtin',
        agentType: 'claude',
        accountProfileId: 'system-default',
        env: { ANTHROPIC_API_KEY: 'synthetic-test-value' },
        logger,
      })
    ).rejects.toThrow('authentication could not be verified');
  });
});

const claudeAuthOverrides = (
  [
    ['CLAUDE_SECURESTORAGE_CONFIG_DIR', ''],
    ['CLAUDE_CODE_OAUTH_TOKEN', 'synthetic-token'],
    ['CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', '3'],
    ['CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', '4'],
    ['CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'synthetic-refresh'],
    ['CLAUDE_CODE_OAUTH_SCOPES', 'user:inference'],
    ['CLAUDE_CODE_HOST_CREDS_FILE', '/another-account/host.json'],
    ['CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', '1'],
    ['CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'OTHER_AUTH'],
    ['CLAUDE_CODE_CUSTOM_OAUTH_URL', 'https://example.test'],
    ['CLAUDE_CODE_OAUTH_CLIENT_ID', 'another-client'],
  ] as const
).flatMap(([key, value]) => [
  [key, value],
  [key.toLowerCase().replace('claude', 'Claude'), value],
]);

describe('provider account isolation', () => {
  it.each(['codex', 'claude'])(
    'leaves legacy and explicit System Default %s environments identical without touching paths',
    async (agentType) => {
      const env = Object.freeze({
        ...Object.fromEntries(claudeAuthOverrides),
        CODEX_HOME: '/native/missing',
        CLAUDE_CONFIG_DIR: '/native/claude',
        ANTHROPIC_API_KEY: 'synthetic',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
      });
      for (const accountProfileId of [undefined, 'system-default']) {
        expect(
          await resolveAccountProfileEnv({
            cliType: 'builtin',
            agentType,
            accountProfileId,
            env,
            profilesRoot: '/does-not-exist',
          })
        ).toBe(env);
      }
    }
  );

  it.each(claudeAuthOverrides)(
    'removes inherited Claude authentication override %s from managed accounts',
    async (key, value) => {
      const input = {
        cliType: 'builtin' as const,
        agentType: 'claude',
        profilesRoot: await temporaryRoot(),
      };
      const profile = await createAccountProfile({ ...input, label: 'Isolated' });
      const original = Object.freeze({
        [key]: value,
        CLAUDE_CONFIG_DIR: '/default-account',
        PATH: '/bin',
      });
      const env = await resolveAccountProfileEnv({
        ...input,
        accountProfileId: profile.accountProfileId,
        env: original,
      });
      expect(env[key]).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBe(
        path.join(input.profilesRoot, 'claude', profile.accountProfileId, 'home')
      );
      expect(original[key]).toBe(value);
      expect(original.CLAUDE_CONFIG_DIR).toBe('/default-account');
      expect(env.PATH).toBe('/bin');
    }
  );

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
