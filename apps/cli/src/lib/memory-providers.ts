import { toShared } from '@/platform/process-options';
import { runCommandTextLegacy } from '@lody/shared/node/process';

import { z } from 'zod';
import {
  MemoryBindingSchema,
  MemoryProviderRequestSchema,
  isLocalOnlyMemoryProvider,
  type MemoryAgent,
  type MemoryBinding,
  type MemoryCreateInput,
  type MemoryIdentity,
  type MemoryProviderRequest,
  type MemoryProviderResponse,
  type MemoryInstall,
  type MemorySignIn,
} from '@lody/shared';
import { getLoginShellEnvLegacy } from '@/agent/login-shell-env';
import { withEverMeNode } from './everme-node';
import { createEverMeMemoryProvider } from './everme-provider';

type CommandResult = { stdout: string; stderr?: string; code?: string | number };
export type MemoryCommandRunner = (args: string[]) => Promise<CommandResult>;
/**
 * A package manager running a package's script exports its own settings as
 * `npm_config_*`, and `npm_config_prefix` among them names that package's own
 * directory. A nested `npm install --global` reads it as its own prefix, so
 * the install lands inside the checkout instead of on the machine and nothing
 * can find it afterwards. Observed with `pnpm run` driving Lody from source.
 * The child gets the machine's npm configuration, never the parent's.
 */
export const withoutInheritedPackageManagerConfig = (
  env: Record<string, string | undefined>
): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !/^npm_config_/i.test(key)));

const createCommandRunner =
  (
    command: string,
    timeout: number,
    prepareEnv?: (env: Record<string, string | undefined>) => Record<string, string | undefined>
  ): MemoryCommandRunner =>
  async (args) => {
    try {
      const inherited = { ...process.env, ...(await getLoginShellEnvLegacy()) };
      const result = await runCommandTextLegacy(
        {
          command,
          args,
          check: 'none',
          env: prepareEnv ? prepareEnv(inherited) : inherited,
          timeout,
          maxOutputBytes: 1024 * 1024,
        },
        toShared()
      );
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code === 0 ? undefined : (result.code ?? 'failed'),
      };
    } catch (error) {
      const parsed = z
        .object({
          code: z.union([z.string(), z.number()]).optional(),
          stdout: z.string().optional(),
          stderr: z.string().optional(),
        })
        .safeParse(error);
      return {
        stdout: parsed.success ? (parsed.data.stdout ?? '') : '',
        stderr: parsed.success ? parsed.data.stderr : undefined,
        code: parsed.success ? (parsed.data.code ?? 'failed') : 'failed',
      };
    }
  };
const runNmem = createCommandRunner('nmem', 15_000);
/** Connecting reaches EverMe's backend to register the agent, so it is slower. */
export const runEvercli = createCommandRunner('evercli', 20_000, (env) =>
  withEverMeNode(withoutInheritedPackageManagerConfig(env))
);
/**
 * Installing fetches a release binary over whatever connection the machine
 * has, so it gets a wall-clock budget rather than a request-sized one; the
 * job outlives the reply that started it either way.
 */
export const runNpm = createCommandRunner('npm', 10 * 60_000, (env) =>
  withEverMeNode(withoutInheritedPackageManagerConfig(env))
);

export interface MemoryProvider {
  id: string;
  probe(): Promise<MemoryProviderResponse['status']>;
  list(): Promise<MemoryIdentity[]>;
  create(input: MemoryCreateInput): Promise<void>;
  update(input: MemoryCreateInput): Promise<void>;
  environment(memoryId: string): Record<string, string>;
  /** Agent-connect providers only; identity providers leave these undefined. */
  agents?(): Promise<MemoryAgent[]>;
  connect?(targets: readonly string[], deadline?: number): Promise<MemoryAgent[]>;
  disconnect?(targets: readonly string[], deadline?: number): Promise<MemoryAgent[]>;
  /** Providers Lody can sign in to; the rest send the user to their own app. */
  signIn?(): Promise<MemorySignIn>;
  signInPoll?(): Promise<MemorySignIn>;
  /** Who the machine is signed in as, when the provider tracks an account. */
  account?(): string | undefined;
  /** Providers Lody can fetch onto the machine; the rest only link to a page. */
  install?(): Promise<MemoryInstall>;
  installPoll?(): Promise<MemoryInstall>;
}

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
      const agents = settled === 'ready' && provider.agents ? await provider.agents() : undefined;
      return {
        type: 'machine/memory',
        status: settled,
        memories: settled === 'ready' ? await provider.list() : [],
        signIn,
        ...(agents ? { agents } : {}),
      };
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
      const settled = await provider.probe();
      const agents = settled === 'ready' && provider.agents ? await provider.agents() : undefined;
      return {
        type: 'machine/memory',
        status: settled,
        memories: [],
        install,
        ...(agents ? { agents } : {}),
      };
    }
    // Leave one second for the reply inside the local RPC limit, including the probe.
    const deadline = Date.now() + 59_000;
    const status = await provider.probe();
    if (status !== 'ready') return { type: 'machine/memory', status, memories: [] };
    if (request.action === 'connect' || request.action === 'disconnect') {
      const apply = request.action === 'connect' ? provider.connect : provider.disconnect;
      if (!apply) throw new Error('This memory provider does not connect agents');
      return {
        type: 'machine/memory',
        status: 'ready',
        memories: [],
        agents: await apply.call(provider, request.targets, deadline),
      };
    }
    if (request.action === 'create') await provider.create(request.input);
    if (request.action === 'update') await provider.update(request.input);
    const agents = provider.agents ? await provider.agents() : undefined;
    const account = provider.account?.();
    return {
      type: 'machine/memory',
      status: 'ready',
      memories: await provider.list(),
      ...(agents ? { agents } : {}),
      ...(account ? { account } : {}),
    };
  } catch {
    return {
      type: 'machine/memory',
      status: 'error',
      memories: [],
      error: 'Memory provider request failed. Check the provider and refresh.',
    };
  }
}
