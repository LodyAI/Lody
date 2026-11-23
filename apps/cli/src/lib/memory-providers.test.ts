import { describe, expect, it, vi } from 'vitest';

import type { MemoryProviderRequest } from '@lody/shared';
import {
  createNowledgeMemoryProvider,
  handleMemoryProviderRequest,
  handleRelayedMemoryProviderRequest,
  memoryEnvironment,
  type MemoryCommandRunner,
  type MemoryProvider,
} from './memory-providers';
import { createEverMeMemoryProvider } from './everme-provider';

describe('Nowledge memory provider', () => {
  it.each(['ok', 'healthy'])(
    'enrolls a literal identity with %s status and returns the updated provider catalog',
    async (status) => {
      const profiles: {
        id: string;
        displayName: string;
        sourceApp: string;
        defaultSpaceId: string;
      }[] = [];
      const provider = createNowledgeMemoryProvider(async (args) => {
        if (args[0] === 'status') return { stdout: JSON.stringify({ status }) };
        if (args[1] === 'enroll') {
          // Model the CLI argv boundary: metacharacters must remain one literal value.
          const name = args[args.indexOf('--name') + 1];
          profiles.push({
            id: args[2] ?? '',
            displayName: name ?? '',
            sourceApp: args[args.indexOf('--source-app') + 1] ?? '',
            defaultSpaceId: args.includes('--default-space')
              ? (args[args.indexOf('--default-space') + 1] ?? '')
              : '',
          });
          return { stdout: '{}' };
        }
        return { stdout: JSON.stringify({ agentProfiles: profiles }) };
      });
      const result = await handleMemoryProviderRequest(
        {
          action: 'create',
          providerId: provider.id,
          input: { id: 'reviewer', name: 'Review $(literal); name' },
        },
        [provider]
      );
      expect(result).toEqual({
        type: 'machine/memory',
        status: 'ready',
        memories: [
          {
            id: 'reviewer',
            name: 'Review $(literal); name',
            description: undefined,
          },
        ],
      });
      expect(profiles[0]).toMatchObject({ sourceApp: 'lody.ai', defaultSpaceId: '' });
      expect(memoryEnvironment({ providerId: provider.id, memoryId: 'reviewer' })).toEqual({
        NMEM_AGENT_ID: 'reviewer',
      });
    }
  );
  it.each(['ok', 'healthy'])(
    'does not mutate identities after a failed %s probe',
    async (status) => {
      const profiles: string[] = [];
      const provider = createNowledgeMemoryProvider(async (args) => {
        if (args[0] === 'status') return { stdout: JSON.stringify({ status }), code: 1 };
        profiles.push(args[2] ?? 'unexpected inventory');
        return { stdout: '{}' };
      });
      for (const action of ['create', 'update'] as const) {
        expect(
          await handleMemoryProviderRequest(
            { action, providerId: provider.id, input: { id: 'reviewer', name: 'Reviewer' } },
            [provider]
          )
        ).toEqual({ type: 'machine/memory', status: 'not_running', memories: [] });
      }
      expect(profiles).toEqual([]);
    }
  );
  it('does not present failed or malformed catalogs as an empty success', async () => {
    const provider = createNowledgeMemoryProvider(async (args) =>
      args[0] === 'status'
        ? { stdout: '{"status":"ok"}' }
        : { stdout: '{"agentProfiles":[{"name":"missing id"}]}' }
    );
    expect(
      (await handleMemoryProviderRequest({ action: 'list', providerId: provider.id }, [provider]))
        .status
    ).toBe('error');
    expect(() => memoryEnvironment({ providerId: 'missing', memoryId: 'reviewer' })).toThrow(
      'Unsupported memory provider'
    );
  });
});

/** Lets the job an install leaves running reach its next await. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const signedIn = { stdout: JSON.stringify({ ok: true, data: { accountId: 'test-account' } }) };
const signedOut = { stdout: JSON.stringify({ ok: false, data: null }), code: 1 };
const noPlatforms = { stdout: JSON.stringify({ ok: true, data: { platforms: [] } }) };

describe('EverMe agent connection job', () => {
  /** A signed-in machine whose Codex row follows the commands EverCLI ran. */
  const connectHarness = (connected: boolean, before?: (args: string[]) => Promise<void>) => {
    const state = { connected, mutations: [] as string[][] };
    const provider = createEverMeMemoryProvider(async (args) => {
      await before?.(args);
      if (args[0] === 'auth') return signedIn;
      if (args[1] === 'install' || args[1] === 'uninstall') {
        state.mutations.push(args);
        state.connected = args[1] === 'install';
        return { stdout: '{}' };
      }
      return {
        stdout: JSON.stringify({
          ok: true,
          data: {
            platforms: [{ platform: 'codex', installed: true, hasEverMeEntry: state.connected }],
          },
        }),
      };
    });
    return { provider, state };
  };
  const ask = (provider: MemoryProvider, request: MemoryProviderRequest) =>
    handleMemoryProviderRequest(request, [provider]);
  const finished = async (provider: MemoryProvider) => {
    for (let tick = 0; tick < 20; tick++) {
      const reply = await ask(provider, { action: 'connectPoll', providerId: 'everme' });
      if (reply.agentsJob?.status !== 'running') return reply;
      await settle();
    }
    throw new Error('the connect job never finished');
  };

  it.each(['connect', 'disconnect'] as const)(
    'answers %s before EverCLI finishes and reports the inventory the job left',
    async (action) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { provider, state } = connectHarness(action === 'disconnect', async (args) => {
        if (args[1] === 'install' || args[1] === 'uninstall') await held;
      });
      const reply = await ask(provider, { action, providerId: 'everme', targets: ['codex'] });
      expect(reply).toMatchObject({ status: 'ready', agentsJob: { status: 'running' } });
      await settle();
      expect(
        (await ask(provider, { action: 'connectPoll', providerId: 'everme' })).agentsJob
      ).toEqual({ status: 'running' });
      release();
      const done = await finished(provider);
      expect(done.agentsJob).toEqual({ status: 'done' });
      expect(done.agents?.find((agent) => agent.id === 'codex')).toMatchObject({
        connected: action === 'connect',
      });
      expect(state.connected).toBe(action === 'connect');
    }
  );

  it('still connects when every EverCLI call takes most of its budget', async () => {
    // Probe and inventory at 19s each used to leave no room for the command
    // inside one request, so every retry was deferred before it started.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    try {
      const { provider, state } = connectHarness(false, async () => {
        vi.setSystemTime(Date.now() + 19_000);
      });
      await ask(provider, { action: 'connect', providerId: 'everme', targets: ['codex'] });
      const done = await finished(provider);
      expect(state.mutations).toHaveLength(1);
      expect(done.agents?.find((agent) => agent.id === 'codex')).toMatchObject({
        connected: true,
      });
      expect(done.agents?.find((agent) => agent.id === 'codex')?.notice).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejoins a running batch instead of starting a second one', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider, state } = connectHarness(false, async (args) => {
      if (args[1] === 'install') await held;
    });
    await ask(provider, { action: 'connect', providerId: 'everme', targets: ['codex'] });
    await settle();
    const second = await ask(provider, {
      action: 'connect',
      providerId: 'everme',
      targets: ['codex'],
    });
    expect(second.agentsJob).toEqual({ status: 'running' });
    release();
    await finished(provider);
    expect(state.mutations).toHaveLength(1);
  });

  it('reports a failed job, and no job at all, as an error to refresh from', async () => {
    const fresh = connectHarness(false).provider;
    expect(await ask(fresh, { action: 'connectPoll', providerId: 'everme' })).toMatchObject({
      status: 'error',
      agentsJob: { status: 'failed' },
    });
    const broken = createEverMeMemoryProvider(async (args) =>
      args[0] === 'auth' ? signedIn : { stdout: 'not json' }
    );
    await ask(broken, { action: 'connect', providerId: 'everme', targets: ['codex'] });
    expect(await finished(broken)).toMatchObject({
      status: 'error',
      agentsJob: { status: 'failed' },
    });
  });
});

describe('EverMe is set up only on the machine itself', () => {
  const requests: MemoryProviderRequest[] = [
    { action: 'list', providerId: 'everme' },
    { action: 'signIn', providerId: 'everme' },
    { action: 'signInPoll', providerId: 'everme' },
    { action: 'install', providerId: 'everme' },
    { action: 'installPoll', providerId: 'everme' },
    { action: 'connectPoll', providerId: 'everme' },
    { action: 'connect', providerId: 'everme', targets: ['codex'] },
    { action: 'disconnect', providerId: 'everme', targets: ['codex'] },
  ];
  it.each(requests)('refuses a relayed $action without running EverCLI or npm', async (request) => {
    const ran: string[][] = [];
    const record: MemoryCommandRunner = async (args) => {
      ran.push(args);
      return signedIn;
    };
    const provider = createEverMeMemoryProvider(record, record, async () => {
      ran.push(['provision-node']);
    });
    const result = await handleRelayedMemoryProviderRequest(request, [provider]);
    expect(result.status).toBe('error');
    expect(result.signIn).toBeUndefined();
    expect(result.install).toBeUndefined();
    expect(result.agents).toBeUndefined();
    expect(result.account).toBeUndefined();
    expect(ran).toEqual([]);
  });
  it('still serves an identity provider over the relay', async () => {
    const provider = createNowledgeMemoryProvider(async (args) =>
      args[0] === 'status'
        ? { stdout: JSON.stringify({ status: 'ok' }) }
        : { stdout: JSON.stringify({ agentProfiles: [{ id: 'reviewer', displayName: 'Review' }] }) }
    );
    const result = await handleRelayedMemoryProviderRequest(
      { action: 'list', providerId: provider.id },
      [provider]
    );
    expect(result.status).toBe('ready');
    expect(result.memories.map((memory) => memory.id)).toEqual(['reviewer']);
  });
});

describe('EverMe browser sign-in', () => {
  const pending = {
    stdout: JSON.stringify({
      ok: true,
      data: {
        status: 'pending',
        deviceCode: 'device-secret',
        userCode: 'ABCD-1234',
        verificationUrl: 'https://everme.test/device?code=ABCD-1234',
        expiresInSec: 600,
      },
    }),
  };
  /** A machine with EverCLI and nobody signed in, until `approve` is called. */
  const signInHarness = (poll: () => { stdout: string; code?: string | number }) => {
    let approved = false;
    const polled: string[] = [];
    const provider = createEverMeMemoryProvider(async (args) => {
      if (args[0] === 'auth' && args[1] === 'status') return approved ? signedIn : signedOut;
      if (args[0] === 'auth' && args.includes('--no-wait')) return pending;
      if (args[0] === 'auth' && args.includes('--device-code')) {
        polled.push(args[args.indexOf('--device-code') + 1] ?? '');
        return poll();
      }
      return noPlatforms;
    });
    return {
      provider,
      polled,
      approve: () => {
        approved = true;
      },
    };
  };

  it('shows the page and the user code but keeps the device code on the machine', async () => {
    const { provider, polled } = signInHarness(() => ({
      stdout: JSON.stringify({ ok: true, data: { status: 'pending' } }),
    }));
    const started = await handleMemoryProviderRequest({ action: 'signIn', providerId: 'everme' }, [
      provider,
    ]);
    expect(started.signIn).toEqual({
      status: 'pending',
      verificationUrl: 'https://everme.test/device?code=ABCD-1234',
      userCode: 'ABCD-1234',
      expiresInSec: 600,
    });
    expect(JSON.stringify(started)).not.toContain('device-secret');
    const polledOnce = await handleMemoryProviderRequest(
      { action: 'signInPoll', providerId: 'everme' },
      [provider]
    );
    expect(polledOnce.signIn).toEqual({ status: 'pending' });
    expect(polled).toEqual(['device-secret']);
  });

  it('keeps a flow pending through a failed poll and a failed status probe', async () => {
    const { provider } = signInHarness(() => ({ stdout: '', code: 'ECONNREFUSED' }));
    await handleMemoryProviderRequest({ action: 'signIn', providerId: 'everme' }, [provider]);
    const result = await handleMemoryProviderRequest(
      { action: 'signInPoll', providerId: 'everme' },
      [provider]
    );
    expect(result.signIn).toEqual({ status: 'pending' });
    expect(result.status).toBe('not_running');
  });

  it('ends the flow only when EverCLI calls the code spent', async () => {
    const { provider, polled } = signInHarness(() => ({
      stdout: JSON.stringify({ ok: false, error: { type: 'auth' } }),
      code: 1,
    }));
    await handleMemoryProviderRequest({ action: 'signIn', providerId: 'everme' }, [provider]);
    const spent = await handleMemoryProviderRequest(
      { action: 'signInPoll', providerId: 'everme' },
      [provider]
    );
    expect(spent.signIn).toEqual({ status: 'expired' });
    const after = await handleMemoryProviderRequest(
      { action: 'signInPoll', providerId: 'everme' },
      [provider]
    );
    expect(after.signIn).toEqual({ status: 'expired' });
    expect(polled).toEqual(['device-secret']);
  });

  it('reports the signed-in machine and its agents once the browser approves', async () => {
    const harness = signInHarness(() => {
      harness.approve();
      return { stdout: JSON.stringify({ ok: true, data: { status: 'approved' } }) };
    });
    await handleMemoryProviderRequest({ action: 'signIn', providerId: 'everme' }, [
      harness.provider,
    ]);
    const result = await handleMemoryProviderRequest(
      { action: 'signInPoll', providerId: 'everme' },
      [harness.provider]
    );
    expect(result.signIn).toEqual({ status: 'approved' });
    expect(result.status).toBe('ready');
    expect(result.agents?.length).toBeGreaterThan(0);
    // The first connection right after signing in names the account it uploads to.
    expect(result.account).toBe('test-account');
  });

  it('stops polling once the code has outlived its own deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const { provider, polled } = signInHarness(() => ({
        stdout: JSON.stringify({ ok: true, data: { status: 'pending' } }),
      }));
      await handleMemoryProviderRequest({ action: 'signIn', providerId: 'everme' }, [provider]);
      vi.setSystemTime(600_001);
      const result = await handleMemoryProviderRequest(
        { action: 'signInPoll', providerId: 'everme' },
        [provider]
      );
      expect(result.signIn).toEqual({ status: 'expired' });
      expect(polled).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an approval page a browser would not open as a web page', async () => {
    const provider = createEverMeMemoryProvider(async (args) => {
      if (args[1] === 'status') return signedOut;
      return {
        stdout: JSON.stringify({
          ok: true,
          data: { status: 'pending', deviceCode: 'device-secret', verificationUrl: 'file:///x' },
        }),
      };
    });
    const result = await handleMemoryProviderRequest({ action: 'signIn', providerId: 'everme' }, [
      provider,
    ]);
    expect(result.status).toBe('error');
    expect(result.signIn).toBeUndefined();
  });

  it('starts no second flow on a machine that is already signed in', async () => {
    const ran: string[][] = [];
    const provider = createEverMeMemoryProvider(async (args) => {
      ran.push(args);
      return args[0] === 'auth' ? signedIn : noPlatforms;
    });
    const result = await handleMemoryProviderRequest({ action: 'signIn', providerId: 'everme' }, [
      provider,
    ]);
    expect(result.signIn).toEqual({ status: 'approved' });
    expect(ran.some((args) => args.includes('login'))).toBe(false);
  });
});

describe('EverMe install', () => {
  /** EverCLI is absent until an npm run that succeeds puts it on the machine. */
  const installHarness = (
    npm: (attempt: number) => { stdout: string; stderr?: string; code?: string | number },
    provision: () => Promise<void> = async () => {}
  ) => {
    let present = false;
    let attempts = 0;
    let provisioned = 0;
    const provider = createEverMeMemoryProvider(
      async (args) => {
        if (args[0] === 'auth') return present ? signedOut : { stdout: '', code: 'ENOENT' };
        return noPlatforms;
      },
      async () => {
        const result = npm(++attempts);
        if (result.code === undefined) present = true;
        return result;
      },
      async () => {
        provisioned++;
        await provision();
      }
    );
    return { provider, attempts: () => attempts, provisioned: () => provisioned };
  };
  const request = (provider: ReturnType<typeof createEverMeMemoryProvider>, action: string) =>
    handleMemoryProviderRequest({ action, providerId: 'everme' } as MemoryProviderRequest, [
      provider,
    ]);

  it('installs with the machine’s own npm and lands signed out', async () => {
    const harness = installHarness(() => ({ stdout: '' }));
    expect((await request(harness.provider, 'install')).install).toEqual({
      status: 'running',
      step: 'provider',
    });
    await settle();
    const landed = await request(harness.provider, 'installPoll');
    expect(landed.install).toEqual({ status: 'done' });
    expect(landed.status).toBe('not_running');
    expect(harness.attempts()).toBe(1);
    expect(harness.provisioned()).toBe(0);
  });

  it.each([
    ['no npm', { stdout: '', code: 'ENOENT' }],
    ['an unwritable global folder', { stdout: '', stderr: 'npm error code EACCES', code: 243 }],
  ])('brings its own Node.js when the machine has %s, then installs', async (_name, failed) => {
    const harness = installHarness((attempt) => (attempt === 1 ? failed : { stdout: '' }));
    await request(harness.provider, 'install');
    await settle();
    expect((await request(harness.provider, 'installPoll')).install).toEqual({ status: 'done' });
    expect(harness.provisioned()).toBe(1);
    expect(harness.attempts()).toBe(2);
  });

  it('names the cause when neither npm nor its own Node.js can install', async () => {
    const harness = installHarness(
      () => ({ stdout: '', stderr: 'npm error code EACCES', code: 243 }),
      async () => {
        throw new Error('offline');
      }
    );
    await request(harness.provider, 'install');
    await settle();
    const result = await request(harness.provider, 'installPoll');
    expect(result.install).toEqual({ status: 'failed', failure: 'permission' });
    expect(result.status).toBe('not_installed');
    expect(harness.attempts()).toBe(1);
  });

  it('does not bring its own Node.js for a failure it cannot explain', async () => {
    const harness = installHarness(() => ({ stdout: '', stderr: 'npm error network', code: 1 }));
    await request(harness.provider, 'install');
    await settle();
    expect((await request(harness.provider, 'installPoll')).install).toEqual({ status: 'failed' });
    expect(harness.provisioned()).toBe(0);
  });

  it('joins a running install instead of starting a second one', async () => {
    let finish: (() => void) | undefined;
    let attempts = 0;
    const provider = createEverMeMemoryProvider(
      async () => ({ stdout: '', code: 'ENOENT' }),
      () =>
        new Promise((resolve) => {
          attempts++;
          finish = () => resolve({ stdout: '' });
        })
    );
    await request(provider, 'install');
    expect((await request(provider, 'install')).install).toEqual({
      status: 'running',
      step: 'provider',
    });
    expect((await request(provider, 'installPoll')).install?.status).toBe('running');
    expect(attempts).toBe(1);
    finish?.();
    await settle();
  });

  it('leaves an EverCLI that already answers alone', async () => {
    let attempts = 0;
    const provider = createEverMeMemoryProvider(
      async (args) => (args[0] === 'auth' ? signedIn : noPlatforms),
      async () => {
        attempts++;
        return { stdout: '' };
      }
    );
    const result = await request(provider, 'install');
    expect(result.install).toEqual({ status: 'done' });
    expect(result.status).toBe('ready');
    expect(attempts).toBe(0);
  });
});
