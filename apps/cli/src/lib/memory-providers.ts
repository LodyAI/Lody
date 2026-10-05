import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  MemoryBindingSchema,
  MemoryProviderRequestSchema,
  type MemoryBinding,
  type MemoryCreateInput,
  type MemoryIdentity,
  type MemoryProviderRequest,
  type MemoryProviderResponse,
} from '@lody/shared';
import { getLoginShellEnv } from '@/agent/login-shell-env';

const execFileAsync = promisify(execFile);
type CommandResult = { stdout: string; code?: string | number };
export type MemoryCommandRunner = (args: string[]) => Promise<CommandResult>;
const runNmem: MemoryCommandRunner = async (args) => {
  try {
    const result = await execFileAsync('nmem', args, {
      env: { ...process.env, ...(await getLoginShellEnv()) },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { stdout: result.stdout };
  } catch (error) {
    const parsed = z
      .object({ code: z.union([z.string(), z.number()]).optional(), stdout: z.string().optional() })
      .safeParse(error);
    return {
      stdout: parsed.success ? (parsed.data.stdout ?? '') : '',
      code: parsed.success ? (parsed.data.code ?? 'failed') : 'failed',
    };
  }
};

export interface MemoryProvider {
  id: string;
  probe(): Promise<MemoryProviderResponse['status']>;
  list(): Promise<MemoryIdentity[]>;
  create(input: MemoryCreateInput): Promise<void>;
  environment(memoryId: string): Record<string, string>;
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
        return status.status === 'ok' && result.code === undefined ? 'ready' : 'not_running';
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
            })
          ),
        })
        .parse(await json(['agents', 'list', '-j']));
      return data.agentProfiles.map((profile) => ({
        id: profile.id,
        name: profile.displayName || profile.id,
        description: profile.description,
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
    environment: (memoryId) => ({ NMEM_AGENT_ID: memoryId }),
  };
}

const providers: readonly MemoryProvider[] = [createNowledgeMemoryProvider()];
export function memoryEnvironment(binding: MemoryBinding | undefined): Record<string, string> {
  if (!binding) return {};
  const validated = MemoryBindingSchema.parse(binding);
  const provider = providers.find((entry) => entry.id === validated.providerId);
  if (!provider) throw new Error(`Unsupported memory provider: ${validated.providerId}`);
  return provider.environment(validated.memoryId);
}

export async function handleMemoryProviderRequest(
  input: MemoryProviderRequest,
  registry: readonly MemoryProvider[] = providers
): Promise<MemoryProviderResponse> {
  try {
    const request = MemoryProviderRequestSchema.parse(input);
    const provider = registry.find((entry) => entry.id === request.providerId);
    if (!provider) throw new Error('Unsupported memory provider');
    const status = await provider.probe();
    if (status !== 'ready') return { type: 'machine/memory', status, memories: [] };
    if (request.action === 'create') await provider.create(request.input);
    return { type: 'machine/memory', status: 'ready', memories: await provider.list() };
  } catch {
    return {
      type: 'machine/memory',
      status: 'error',
      memories: [],
      error: 'Memory provider request failed. Check the provider and refresh.',
    };
  }
}
