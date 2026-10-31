import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MAGPIE_TOKEN, normalizeMagpieGateway } from '@lody/shared';
import { mergeLoopbackNoProxy } from '@lody/shared/proxy-env';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

import type { DeepSeekHarnessCatalogModel } from '@/agent/deepseek-harness-runtime';

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
  // Capability metadata is extended information, not an OpenAI list requirement.
  modalities: z.object({ input: z.array(z.string().max(32)).max(8).optional() }).optional(),
});
const catalogSchema = z.object({ data: z.array(z.unknown()).min(1).max(2048) });
export type MagpieModel = z.infer<typeof modelSchema>;

/** Missing capability metadata falls back to text-only, never to an image claim. */
const acceptsImageInput = (model: MagpieModel) =>
  model.modalities?.input?.includes('image') ?? false;

/** Validate each entry separately so one bad model names itself instead of the catalog. */
function parseMagpieCatalog(payload: unknown): MagpieModel[] {
  const catalog = catalogSchema.safeParse(payload);
  if (!catalog.success) throw new Error('Magpie returned an invalid or empty model catalog');
  const models: MagpieModel[] = [];
  const problems: string[] = [];
  catalog.data.data.forEach((entry, index) => {
    const parsed = modelSchema.safeParse(entry);
    if (parsed.success) {
      models.push(parsed.data);
      return;
    }
    const id =
      typeof entry === 'object' && entry !== null && 'id' in entry && typeof entry.id === 'string'
        ? ` ${entry.id}`
        : '';
    for (const issue of parsed.error.issues) {
      const field = issue.path.length ? issue.path.join('.') : '<entry>';
      problems.push(`data[${index}]${id}: ${field} ${issue.message}`);
    }
  });
  if (problems.length) {
    const shown = problems.slice(0, 3).join('; ');
    const rest = problems.length > 3 ? ` (+${problems.length - 3} more)` : '';
    throw new Error(`Magpie returned an invalid model catalog: ${shown}${rest}`);
  }
  return models;
}

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
  const models = parseMagpieCatalog(await readJson(`${base}/v1/models`, bounded, fetcher));
  if (new Set(models.map((m) => m.id)).size !== models.length)
    throw new Error('Magpie returned duplicate models');
  return models;
}

/**
 * Map Magpie's advisory catalog onto the Harness `llm-deepseek.models` schema.
 *
 * The Harness reads model capabilities only from this configured catalog: its
 * endpoint discovery yields bare ids, so a gateway catalog alone always
 * resolves text-only and cannot advertise ACP image prompts.
 */
export function buildDeepSeekHarnessModels(
  models: readonly MagpieModel[]
): DeepSeekHarnessCatalogModel[] {
  return models.map((m) => ({
    id: m.id,
    name: m.display_name ?? m.id,
    // Report only what the catalog states; the Harness defaults stay in charge
    // of anything Magpie leaves out, exactly as they do without this catalog.
    ...(m.context_window ? { contextWindow: m.context_window } : {}),
    ...(m.max_output_tokens ? { maxTokens: m.max_output_tokens } : {}),
    inputModalities: acceptsImageInput(m) ? (['text', 'image'] as const) : (['text'] as const),
  }));
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
          input: acceptsImageInput(m) ? ['text', 'image'] : ['text'],
          contextWindow: m.context_window ?? 128000,
          maxTokens: m.max_output_tokens ?? 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      },
    },
  };
}

// JSON string escaping is also valid for TOML basic strings. Catalog text is
// always quoted, including table keys, so model IDs cannot inject configuration.
const quoted = (value: string) => JSON.stringify(value).replace(/\u007f/g, '\\u007f');
const stringArray = (values: readonly string[]) => `[${values.map(quoted).join(', ')}]`;

export function buildMagpieKimiConfig(gateway: string, models: readonly MagpieModel[]): string {
  return [
    `default_model = ${quoted(`magpie/${models[0]!.id}`)}`,
    '[providers.magpie]',
    'type = "kimi"',
    `base_url = ${quoted(`${gateway}/v1`)}`,
    `api_key = ${quoted(MAGPIE_TOKEN)}`,
    ...models.flatMap((m) => {
      const efforts = (m.supported_reasoning_levels ?? [])
        .map((l) => l.effort)
        .filter((e) => e !== 'none');
      return [
        `[models.${quoted(`magpie/${m.id}`)}]`,
        'provider = "magpie"',
        `model = ${quoted(m.id)}`,
        `display_name = ${quoted(m.display_name ?? m.id)}`,
        `max_context_size = ${m.context_window ?? 128000}`,
        `max_output_size = ${m.max_output_tokens ?? 8192}`,
        `capabilities = ${stringArray(['tool_use', ...(acceptsImageInput(m) ? ['image_in'] : []), ...(m.reasoning || efforts.length ? ['thinking'] : [])])}`,
        ...(efforts.length
          ? [
              `support_efforts = ${stringArray(efforts)}`,
              `default_effort = ${quoted(efforts.includes('medium') ? 'medium' : efforts[0]!)}`,
            ]
          : []),
      ];
    }),
    '',
  ].join('\n');
}

export function buildMagpieGrokConfig(gateway: string, models: readonly MagpieModel[]): string {
  return [
    '[models]',
    `default = ${quoted(`magpie/${models[0]!.id}`)}`,
    `allowed_models = ${stringArray(models.map((m) => `magpie/${m.id}`))}`,
    `session_summary = ${quoted(`magpie/${models[0]!.id}`)}`,
    `prompt_suggestion = ${quoted(`magpie/${models[0]!.id}`)}`,
    `web_search = ${quoted(`magpie/${models[0]!.id}`)}`,
    `image_description = ${quoted(`magpie/${models.find(acceptsImageInput)?.id ?? models[0]!.id}`)}`,
    '[features]',
    'campaigns = false',
    ...models.flatMap((m) => [
      `[model.${quoted(`magpie/${m.id}`)}]`,
      `model = ${quoted(m.id)}`,
      `name = ${quoted(m.display_name ?? m.id)}`,
      `base_url = ${quoted(`${gateway}/v1`)}`,
      `api_key = ${quoted(MAGPIE_TOKEN)}`,
      'api_backend = "chat_completions"',
      `context_window = ${m.context_window ?? 128000}`,
      `max_completion_tokens = ${m.max_output_tokens ?? 8192}`,
      ...(m.supported_reasoning_levels?.length
        ? [
            `reasoning_efforts = ${stringArray(m.supported_reasoning_levels.map((l) => l.effort).filter((e) => e !== 'ultra'))}`,
          ]
        : []),
    ]),
    '',
  ].join('\n');
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, typeof value === 'string' ? value : JSON.stringify(value), {
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Local generated catalogs live outside the user's native profiles. */
export async function prepareMagpieRuntime(
  agentType: string,
  gateway: string,
  signal?: AbortSignal,
  root = join(getLodyDataDir(), 'magpie'),
  fetcher: typeof fetch = fetch
): Promise<{
  env: Record<string, string>;
  args: string[];
  /**
   * The DeepSeek Harness needs the catalog in its own profile, not only in the
   * environment: without it the provider cannot resolve image support.
   */
  modelCatalog?: DeepSeekHarnessCatalogModel[];
}> {
  const base = normalizeMagpieGateway(gateway);
  if (!['claude', 'codex', 'pi', 'deepseek', 'kimi', 'grok', 'bub'].includes(agentType))
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
    return {
      args: [],
      env: { DEEPSEEK_BASE_URL: `${base}/v1`, DEEPSEEK_API_KEY: MAGPIE_TOKEN },
      modelCatalog: buildDeepSeekHarnessModels(models),
    };
  if (agentType === 'bub') {
    // Python HTTP clients can inherit macOS system proxies even without HTTP_PROXY.
    const bypass = mergeLoopbackNoProxy(process.env.NO_PROXY, process.env.no_proxy);
    return {
      args: [],
      env: {
        BUB_MODEL: `openai:${first.id}`,
        BUB_MAX_TOKENS: String(first.max_output_tokens ?? 8192),
        BUB_API_BASE: `${base}/v1`,
        BUB_API_KEY: MAGPIE_TOKEN,
        BUB_PROVIDERS: '{}',
        BUB_FALLBACK_MODELS: '[]',
        NO_PROXY: bypass,
        no_proxy: bypass,
      },
    };
  }
  const directory = join(
    root,
    createHash('sha256').update(base).digest('hex').slice(0, 24),
    agentType
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (agentType === 'kimi' || agentType === 'grok') {
    const config =
      agentType === 'kimi'
        ? buildMagpieKimiConfig(base, models)
        : buildMagpieGrokConfig(base, models);
    await writeAtomic(join(directory, 'config.toml'), config);
    return {
      args: [],
      env:
        agentType === 'kimi'
          ? { KIMI_CODE_HOME: directory, KIMI_MODEL_NAME: '' }
          : {
              GROK_HOME: directory,
              GROK_CONFIG: '{}',
              GROK_DEFAULT_MODEL: `magpie/${first.id}`,
              GROK_WEB_SEARCH_MODEL: `magpie/${first.id}`,
            },
    };
  }
  if (agentType === 'pi') {
    await writeAtomic(join(directory, 'models.json'), buildMagpiePiCatalog(base, models));
    return {
      args: ['--provider', 'magpie', '--model', first.id],
      env: { PI_CODING_AGENT_DIR: directory },
    };
  }
  // Codex reads the catalog Magpie serves in Codex's own shape, so capability
  // metadata is mapped once, on the side that knows the vendor's answer, the
  // user's per-model override and Codex's field vocabulary. `agent=lody` keeps
  // the models picked for Lody in Magpie rather than Codex's own picks.
  const config = JSON.stringify({
    model_provider: 'magpie',
    model: first.id,
    model_providers: {
      magpie: {
        name: 'Magpie',
        base_url: `${base}/v1`,
        model_catalog_url: `${base}/v1/codex/models?agent=lody`,
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
