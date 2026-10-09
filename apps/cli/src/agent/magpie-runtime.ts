import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MAGPIE_TOKEN, normalizeMagpieGateway } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

const modelSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\s\p{Cc}]+$/u),
  display_name: z.string().max(256).optional(),
  reasoning: z.boolean().optional(),
  supported_reasoning_levels: z
    .array(
      z.object({
        effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
      })
    )
    .max(8)
    .optional(),
  context_window: z.number().int().positive().max(100_000_000).optional(),
  max_output_tokens: z.number().int().positive().max(100_000_000).optional(),
  modalities: z.object({ input: z.array(z.string().max(32)).max(8) }).optional(),
});
const catalogSchema = z.object({ data: z.array(modelSchema).min(1).max(2048) });
export type MagpieModel = z.infer<typeof modelSchema>;

/** Bound bytes before decoding; never follow a gateway redirect to a different service. */
async function readJson(url: string, signal: AbortSignal, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${MAGPIE_TOKEN}` },
    redirect: 'error',
    signal,
  });
  if (!response.ok || !response.body) throw new Error('Magpie gateway is unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error('Magpie catalog is too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function readMagpieModels(
  gateway: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<MagpieModel[]> {
  const base = normalizeMagpieGateway(gateway);
  const bounded = AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
  const hello = z
    .object({ name: z.literal('magpie') })
    .safeParse(await readJson(`${base}/api/hello`, bounded, fetcher));
  if (!hello.success) throw new Error('The local endpoint is not Magpie');
  const parsed = catalogSchema.safeParse(await readJson(`${base}/v1/models`, bounded, fetcher));
  if (!parsed.success) throw new Error('Magpie returned an invalid or empty model catalog');
  if (new Set(parsed.data.data.map((m) => m.id)).size !== parsed.data.data.length)
    throw new Error('Magpie returned duplicate models');
  return parsed.data.data;
}

export function buildMagpieCodexCatalog(models: readonly MagpieModel[]) {
  return {
    models: models.map((m, i) => ({
      slug: m.id,
      display_name: m.display_name ?? m.id,
      description: `${m.display_name ?? m.id} via Magpie`,
      base_instructions:
        'You are a coding assistant. Help the user complete their software development tasks accurately and safely.',
      default_reasoning_level:
        m.supported_reasoning_levels?.find((l) => l.effort === 'medium')?.effort ??
        m.supported_reasoning_levels?.[0]?.effort ??
        null,
      supported_reasoning_levels: (m.supported_reasoning_levels ?? []).map((l) => ({
        ...l,
        description: l.effort,
      })),
      shell_type: 'unified_exec',
      visibility: 'list',
      supported_in_api: true,
      priority: i,
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: 'freeform',
      truncation_policy: { mode: 'tokens', limit: 10000 },
      experimental_supported_tools: [],
      input_modalities: m.modalities?.input.includes('image') ? ['text', 'image'] : ['text'],
      context_window: m.context_window ?? 128000,
      supports_parallel_tool_calls: true,
    })),
  };
}

export function buildMagpiePiCatalog(gateway: string, models: readonly MagpieModel[]) {
  return {
    providers: {
      magpie: {
        baseUrl: `${gateway}/v1`,
        api: 'openai-completions',
        apiKey: MAGPIE_TOKEN,
        models: models.map((m) => ({
          id: m.id,
          name: m.display_name ?? m.id,
          reasoning: m.reasoning ?? false,
          input: m.modalities?.input.includes('image') ? ['text', 'image'] : ['text'],
          contextWindow: m.context_window ?? 128000,
          maxTokens: m.max_output_tokens ?? 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      },
    },
  };
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Local generated catalogs live outside the user's native Codex/Pi profiles. */
export async function prepareMagpieRuntime(
  agentType: string,
  gateway: string,
  signal?: AbortSignal,
  root = join(getLodyDataDir(), 'magpie'),
  fetcher: typeof fetch = fetch
): Promise<{ env: Record<string, string>; args: string[] }> {
  const base = normalizeMagpieGateway(gateway);
  if (!['claude', 'codex', 'pi', 'deepseek'].includes(agentType))
    throw new Error('Unsupported Magpie runtime');
  const models = await readMagpieModels(base, signal, fetcher);
  signal?.throwIfAborted();
  const first = models[0];
  if (!first) throw new Error('Magpie has no enabled models');
  if (agentType === 'claude')
    return {
      args: [],
      env: {
        ANTHROPIC_BASE_URL: base,
        ANTHROPIC_AUTH_TOKEN: MAGPIE_TOKEN,
        ANTHROPIC_MODEL: first.id,
        CLAUDE_MODEL_CONFIG: JSON.stringify({ availableModels: models.map((m) => m.id) }),
      },
    };
  if (agentType === 'deepseek')
    return { args: [], env: { DEEPSEEK_BASE_URL: `${base}/v1`, DEEPSEEK_API_KEY: MAGPIE_TOKEN } };
  const directory = join(
    root,
    createHash('sha256').update(base).digest('hex').slice(0, 24),
    agentType
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (agentType === 'pi') {
    await writeAtomic(join(directory, 'models.json'), buildMagpiePiCatalog(base, models));
    return {
      args: ['--provider', 'magpie', '--model', first.id],
      env: { PI_CODING_AGENT_DIR: directory },
    };
  }
  // Content-addressed catalogs keep concurrent launches on their exact snapshot.
  const catalog = buildMagpieCodexCatalog(models);
  const catalogPath = join(
    directory,
    `models-${createHash('sha256').update(JSON.stringify(catalog)).digest('hex').slice(0, 24)}.json`
  );
  await writeAtomic(catalogPath, catalog);
  const config = JSON.stringify({
    model_provider: 'magpie',
    model: first.id,
    model_catalog_json: catalogPath,
    model_providers: {
      magpie: {
        name: 'Magpie',
        base_url: `${base}/v1`,
        env_key: 'OPENAI_API_KEY',
        wire_api: 'responses',
        requires_openai_auth: false,
      },
    },
  });
  return {
    args: [],
    env: {
      CODEX_HOME: directory,
      OPENAI_API_KEY: MAGPIE_TOKEN,
      MODEL_PROVIDER: 'magpie',
      CODEX_CONFIG: config,
      // The adapter applies this overlay before native model/list and auth checks.
      LODY_CODEX_PROFILE_CONFIG: config,
    },
  };
}
