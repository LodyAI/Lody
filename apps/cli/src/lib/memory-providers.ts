import { z } from 'zod';
import {
  MemoryBindingSchema,
  MemoryProviderRequestSchema,
  isLocalOnlyMemoryProvider,
  type MemoryAgent,
  type MemoryAgentsJob,
  type MemoryBinding,
  type MemoryCreateInput,
  type MemoryIdentity,
  type MemoryProviderRequest,
  type MemoryProviderResponse,
  type MemoryInstall,
  type MemorySignIn,
} from '@lody/shared';
import { createEverMeMemoryProvider } from './everme-provider';
import { runNmem, type MemoryCommandRunner } from './memory-command-runner';

export type { MemoryCommandRunner } from './memory-command-runner';

export interface MemoryProvider {
  id: string;
  probe(): Promise<MemoryProviderResponse['status']>;
  list(): Promise<MemoryIdentity[]>;
  create(input: MemoryCreateInput): Promise<void>;
  update(input: MemoryCreateInput): Promise<void>;
  environment(memoryId: string): Record<string, string>;
  /**
   * Agent-connect providers only; identity providers leave these undefined.
   * `connect` and `disconnect` start a job and answer at once; `connectPoll`
   * reports it, with the inventory it left once it is done.
   */
  agents?(): Promise<MemoryAgent[]>;
  connect?(targets: readonly string[]): Promise<MemoryAgentsSnapshot>;
  disconnect?(targets: readonly string[]): Promise<MemoryAgentsSnapshot>;
  connectPoll?(): Promise<MemoryAgentsSnapshot>;
  /** Providers Lody can sign in to; the rest send the user to their own app. */
  signIn?(): Promise<MemorySignIn>;
  signInPoll?(): Promise<MemorySignIn>;
  /** Who the machine is signed in as, when the provider tracks an account. */
  account?(): string | undefined;
  /** Providers Lody can fetch onto the machine; the rest only link to a page. */
  install?(): Promise<MemoryInstall>;
  installPoll?(): Promise<MemoryInstall>;
}

export type MemoryAgentsSnapshot = { job: MemoryAgentsJob; agents?: MemoryAgent[] };

const agentsJobReply = (
  provider: MemoryProvider,
  { job, agents }: MemoryAgentsSnapshot
): MemoryProviderResponse => {
  const account = provider.account?.();
  return job.status === 'failed'
    ? {
        type: 'machine/memory',
        status: 'error',
        memories: [],
        agentsJob: job,
        error: 'Memory provider request failed. Check the provider and refresh.',
      }
    : {
        type: 'machine/memory',
        status: 'ready',
        memories: [],
        agentsJob: job,
        ...(agents ? { agents } : {}),
        ...(account ? { account } : {}),
      };
};

export function createNowledgeMemoryProvider(run: MemoryCommandRunner = runNmem): MemoryProvider {
  const json = async (args: string[]) => {
    const result = await run(args);
    if (result.code !== undefined)
      throw new Error('Nowledge Mem command failed. Refresh its status and try again.');
    return JSON.parse(result.stdout) as unknown;
  };
  return {
    id: 'nowledge-mem',
    async probe() {
      const result = await run(['status', '-j']);
      if (result.code === 'ENOENT') return 'not_installed';
      try {
        const status = z.object({ status: z.string() }).parse(JSON.parse(result.stdout));
        return (status.status === 'ok' || status.status === 'healthy') && result.code === undefined
          ? 'ready'
          : 'not_running';
      } catch {
        return result.code !== undefined ? 'not_running' : 'error';
      }
    },
    async list() {
      const data = z
        .object({
          agentProfiles: z.array(
            z.object({
              id: z.string().min(1),
              displayName: z.string().optional(),
              description: z.string().optional(),
              role: z.string().optional(),
            })
          ),
        })
        .parse(await json(['agents', 'list', '-j']));
      return data.agentProfiles.map((profile) => ({
        id: profile.id,
        name: profile.displayName || profile.id,
        description: profile.description,
        role: profile.role,
      }));
    },
    async create(input) {
      const args = ['agents', 'enroll', input.id, '-j', '--source-app', 'lody.ai'];
      for (const [key, flag] of [
        ['name', '--name'],
        ['description', '--description'],
        ['role', '--role'],
        ['defaultSpace', '--default-space'],
      ] as const) {
        if (input[key]) args.push(flag, input[key]);
      }
      await json(args);
    },
    async update(input) {
      const args = ['agents', 'set', input.id, '-j'];
      for (const [key, flag] of [
        ['name', '--name'],
        ['description', '--description'],
        ['role', '--role'],
      ] as const) {
        // Empty strings explicitly clear editable fields. Hidden fields remain unchanged.
        if (input[key] !== undefined) args.push(flag, input[key]);
      }
      await json(args);
    },
    environment: (memoryId) => ({ NMEM_AGENT_ID: memoryId }),
  };
}

const providers: readonly MemoryProvider[] = [
  createNowledgeMemoryProvider(),
  createEverMeMemoryProvider(),
];
export function memoryEnvironment(binding: MemoryBinding | undefined): Record<string, string> {
  if (!binding) return {};
  const validated = MemoryBindingSchema.parse(binding);
  const provider = providers.find((entry) => entry.id === validated.providerId);
  if (!provider) throw new Error(`Unsupported memory provider: ${validated.providerId}`);
  return provider.environment(validated.memoryId);
}

/**
 * Requests relayed through the workspace rather than sent over this machine's
 * local channel. Anyone who can see the machine in a workspace can reach this
 * path, so account providers are refused here instead of trusting the page to
 * have hidden their buttons.
 */
export async function handleRelayedMemoryProviderRequest(
  input: MemoryProviderRequest,
  registry: readonly MemoryProvider[] = providers
): Promise<MemoryProviderResponse> {
  if (isLocalOnlyMemoryProvider(input.providerId))
    return {
      type: 'machine/memory',
      status: 'error',
      memories: [],
      error: 'This memory provider can only be set up on the machine it runs on.',
    };
  return handleMemoryProviderRequest(input, registry);
}

/**
 * The reply for a provider whose probe already ran. Built from that probe
 * rather than a second one, so every action that lands on a ready provider —
 * a finished sign-in or install as much as a list — answers with the same
 * inventory and account.
 */
async function settledReply(
  provider: MemoryProvider,
  status: MemoryProviderResponse['status']
): Promise<MemoryProviderResponse> {
  if (status !== 'ready') return { type: 'machine/memory', status, memories: [] };
  const agents = provider.agents ? await provider.agents() : undefined;
  const account = provider.account?.();
  return {
    type: 'machine/memory',
    status: 'ready',
    memories: await provider.list(),
    ...(agents ? { agents } : {}),
    ...(account ? { account } : {}),
  };
}

export async function handleMemoryProviderRequest(
  input: MemoryProviderRequest,
  registry: readonly MemoryProvider[] = providers
): Promise<MemoryProviderResponse> {
  try {
    const request = MemoryProviderRequestSchema.parse(input);
    const provider = registry.find((entry) => entry.id === request.providerId);
    if (!provider) throw new Error('Unsupported memory provider');
    // Signing in is the one request made precisely because nobody is signed
    // in, so it runs ahead of the readiness gate the others wait behind.
    if (request.action === 'signIn' || request.action === 'signInPoll') {
      const begin = request.action === 'signIn' ? provider.signIn : provider.signInPoll;
      if (!begin) throw new Error('This memory provider does not sign in from Lody');
      const signIn = await begin.call(provider);
      // A flow that ended — approved, or spent — is worth a real look: the
      // account may now exist, or may have been made elsewhere. A flow still
      // pending is not. Probing on every tick let one failed probe answer
      // `error` while the browser was still open, which tore the sign-in card
      // down and abandoned the device code the daemon was holding — the exact
      // failure this flow is built to survive.
      const settled = signIn.status === 'pending' ? 'not_running' : await provider.probe();
      return { ...(await settledReply(provider, settled)), signIn };
    }
    // Installing is asked for because the provider is absent, so it too runs
    // ahead of the gate — and reports the probe beside the job, since the
    // moment the probe stops saying `not_installed` is the moment it landed.
    if (request.action === 'install' || request.action === 'installPoll') {
      const begin = request.action === 'install' ? provider.install : provider.installPoll;
      if (!begin) throw new Error('This memory provider does not install from Lody');
      const install = await begin.call(provider);
      // A machine that was already signed in is ready the moment the binary
      // lands. Answering without its agents would have the panel assert, for
      // one whole refresh interval, that the provider adapts none of them.
      return { ...(await settledReply(provider, await provider.probe())), install };
    }
    // Asking after a job reads what the job left; the probe that gated the
    // click already ran, and probing again on every tick is the slow part.
    if (request.action === 'connectPoll') {
      if (!provider.connectPoll) throw new Error('This memory provider does not connect agents');
      return agentsJobReply(provider, await provider.connectPoll());
    }
    const status = await provider.probe();
    if (status !== 'ready') return { type: 'machine/memory', status, memories: [] };
    if (request.action === 'connect' || request.action === 'disconnect') {
      const apply = request.action === 'connect' ? provider.connect : provider.disconnect;
      if (!apply) throw new Error('This memory provider does not connect agents');
      return agentsJobReply(provider, await apply.call(provider, request.targets));
    }
    if (request.action === 'create') await provider.create(request.input);
    if (request.action === 'update') await provider.update(request.input);
    return await settledReply(provider, status);
  } catch {
    return {
      type: 'machine/memory',
      status: 'error',
      memories: [],
      error: 'Memory provider request failed. Check the provider and refresh.',
    };
  }
}
