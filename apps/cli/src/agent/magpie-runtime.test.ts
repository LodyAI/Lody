import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareMagpieRuntime, readMagpieModels } from './magpie-runtime';
const gateway = 'http://127.0.0.1:3425';
const models = [
  {
    id: 'vendor/model',
    display_name: 'Test model',
    reasoning: true,
    supported_reasoning_levels: [{ effort: 'medium' }],
    context_window: 64000,
    max_output_tokens: 4096,
    modalities: { input: ['text', 'image'] },
  },
];
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const fetcher: typeof fetch = async (input, init) => {
  expect(init?.redirect).toBe('error');
  expect(init?.headers).toEqual({ Authorization: 'Bearer magpie-lody' });
  if (String(input) === `${gateway}/api/hello`) return Response.json({ name: 'magpie' });
  if (String(input) === `${gateway}/v1/models`) return Response.json({ data: models });
  throw new Error('Unexpected destination');
};
async function root() {
  const d = await mkdtemp(join(tmpdir(), 'lody-magpie-test-'));
  directories.push(d);
  return d;
}
describe('Magpie runtime preparation', () => {
  it('produces isolated usable Codex and Pi profiles from the gateway catalog', async () => {
    const directory = await root();
    const codex = await prepareMagpieRuntime('codex', gateway, undefined, directory, fetcher);
    const config = JSON.parse(codex.env.CODEX_CONFIG ?? '{}');
    expect(config.model_provider).toBe('magpie');
    expect(config.model_catalog_json).toBeUndefined();
    expect(config.model_providers.magpie).toMatchObject({
      base_url: `${gateway}/v1`,
      model_catalog_url: `${gateway}/v1/codex/models?agent=lody`,
      requires_openai_auth: false,
      wire_api: 'responses',
    });
    expect(codex.env.CODEX_HOME?.startsWith(directory)).toBe(true);
    // Codex asks the gateway for the catalog; Lody writes none of its own.
    expect(await readdir(codex.env.CODEX_HOME ?? '')).toEqual([]);
    const pi = await prepareMagpieRuntime('pi', gateway, undefined, directory, fetcher);
    expect(pi.args).toEqual(['--provider', 'magpie', '--model', 'vendor/model']);
    const piCatalog = JSON.parse(
      await readFile(join(pi.env.PI_CODING_AGENT_DIR ?? '', 'models.json'), 'utf8')
    );
    expect(piCatalog.providers.magpie).toMatchObject({
      baseUrl: `${gateway}/v1`,
      api: 'openai-completions',
      apiKey: 'magpie-lody',
    });
    expect(piCatalog.providers.magpie.models[0]).toMatchObject({
      id: 'vendor/model',
      contextWindow: 64000,
      maxTokens: 4096,
    });
  });
  it('passes the discovered Claude models and DSH endpoint through their native contracts', async () => {
    const directory = await root();
    const claude = await prepareMagpieRuntime('claude', gateway, undefined, directory, fetcher);
    expect(JSON.parse(claude.env.CLAUDE_MODEL_CONFIG ?? '{}')).toEqual({
      availableModels: ['vendor/model'],
    });
    expect(claude.env.ANTHROPIC_AUTH_TOKEN).toBe('magpie-lody');
    const dsh = await prepareMagpieRuntime('deepseek', gateway, undefined, directory, fetcher);
    expect(dsh.env).toEqual({
      DEEPSEEK_BASE_URL: `${gateway}/v1`,
      DEEPSEEK_API_KEY: 'magpie-lody',
    });
  });
  it('loads isolated Kimi and Grok TOML with literal model keys and bounded model selection', async () => {
    const directory = await root();
    const tricky = {
      ...models[0],
      id: 'vendor/"quoted".model',
      display_name: 'A "name"\n[providers.injected]\u007f',
    };
    const catalog: typeof fetch = async (input, init) =>
      String(input).endsWith('/models')
        ? Response.json({ data: [tricky, { id: 'second/model' }] })
        : fetcher(input, init);
    const kimi = await prepareMagpieRuntime('kimi', gateway, undefined, directory, catalog);
    const grok = await prepareMagpieRuntime('grok', gateway, undefined, directory, catalog);
    expect(kimi.env.KIMI_CODE_HOME?.startsWith(directory)).toBe(true);
    expect(grok.env.GROK_HOME?.startsWith(directory)).toBe(true);
    expect(kimi.env.KIMI_CODE_HOME).not.toBe(grok.env.GROK_HOME);
    const k = parseToml(await readFile(join(kimi.env.KIMI_CODE_HOME!, 'config.toml'), 'utf8'));
    const g = parseToml(await readFile(join(grok.env.GROK_HOME!, 'config.toml'), 'utf8'));
    const selected = `magpie/${tricky.id}`;
    expect(k).toMatchObject({
      default_model: selected,
      providers: { magpie: { type: 'kimi', base_url: `${gateway}/v1`, api_key: 'magpie-lody' } },
      models: {
        [selected]: {
          model: tricky.id,
          display_name: tricky.display_name,
          max_context_size: 64000,
          support_efforts: ['medium'],
          capabilities: ['tool_use', 'image_in', 'thinking'],
        },
      },
    });
    expect(Object.keys(k.providers as object)).toEqual(['magpie']);
    expect(g).toMatchObject({
      features: { campaigns: false },
      models: {
        default: selected,
        allowed_models: [selected, 'magpie/second/model'],
        session_summary: selected,
        prompt_suggestion: selected,
      },
      model: {
        [selected]: {
          model: tricky.id,
          name: tricky.display_name,
          api_backend: 'chat_completions',
          base_url: `${gateway}/v1`,
          api_key: 'magpie-lody',
          reasoning_efforts: ['medium'],
        },
      },
    });
    expect(Object.keys(g.model as object)).toEqual([selected, 'magpie/second/model']);
  });
  it('configures Bub through its native OpenAI environment without enabling fallback models', async () => {
    const directory = await root();
    vi.stubEnv('NO_PROXY', 'corp.internal');
    vi.stubEnv('no_proxy', 'other.internal,corp.internal');
    const bub = await prepareMagpieRuntime('bub', gateway, undefined, directory, fetcher);
    expect(bub).toEqual({
      args: [],
      env: {
        BUB_MODEL: 'openai:vendor/model',
        BUB_MAX_TOKENS: '4096',
        BUB_API_BASE: `${gateway}/v1`,
        BUB_API_KEY: 'magpie-lody',
        BUB_PROVIDERS: '{}',
        BUB_FALLBACK_MODELS: '[]',
        NO_PROXY: 'corp.internal,other.internal,localhost,127.0.0.1,::1',
        no_proxy: 'corp.internal,other.internal,localhost,127.0.0.1,::1',
      },
    });
    expect(await readdir(directory)).toEqual([]);
  });
  it('rejects other services, empty and malformed catalogs before writing profiles', async () => {
    const directory = await root();
    for (const response of [
      { name: 'other' },
      { name: 'magpie', data: [] },
      { name: 'magpie', data: [{ id: 'bad\nmodel' }] },
    ]) {
      const invalid: typeof fetch = async () => Response.json(response);
      await expect(
        prepareMagpieRuntime('pi', gateway, undefined, directory, invalid)
      ).rejects.toThrow();
    }
    expect(await readdir(directory)).toEqual([]);
  });
  it('treats missing or incomplete capability metadata as text-only', async () => {
    const directory = await root();
    const mixed: typeof fetch = async (input, init) =>
      String(input).endsWith('/models')
        ? Response.json({
            data: [
              { id: 'declared-text/model', modalities: { input: ['text'] } },
              { id: 'output-only/model', modalities: { output: ['text'] } },
              { id: 'bare/model' },
              { id: 'vision/model', modalities: { input: ['text', 'image'] } },
            ],
          })
        : fetcher(input, init);
    expect((await readMagpieModels(gateway, undefined, mixed)).map((m) => m.id)).toEqual([
      'declared-text/model',
      'output-only/model',
      'bare/model',
      'vision/model',
    ]);
    const codex = await prepareMagpieRuntime('codex', gateway, undefined, directory, mixed);
    expect(
      JSON.parse(codex.env.CODEX_CONFIG ?? '{}').model_providers.magpie.model_catalog_url
    ).toBe(`${gateway}/v1/codex/models?agent=lody`);
    const pi = await prepareMagpieRuntime('pi', gateway, undefined, directory, mixed);
    const piCatalog = JSON.parse(
      await readFile(join(pi.env.PI_CODING_AGENT_DIR ?? '', 'models.json'), 'utf8')
    );
    expect(piCatalog.providers.magpie.models.map((m: { input: string[] }) => m.input)).toEqual([
      ['text'],
      ['text'],
      ['text'],
      ['text', 'image'],
    ]);
    const kimi = await prepareMagpieRuntime('kimi', gateway, undefined, directory, mixed);
    const k = parseToml(await readFile(join(kimi.env.KIMI_CODE_HOME!, 'config.toml'), 'utf8'));
    expect(k).toMatchObject({
      models: {
        'magpie/output-only/model': { capabilities: ['tool_use'] },
        'magpie/vision/model': { capabilities: ['tool_use', 'image_in'] },
      },
    });
    const grok = await prepareMagpieRuntime('grok', gateway, undefined, directory, mixed);
    const g = parseToml(await readFile(join(grok.env.GROK_HOME!, 'config.toml'), 'utf8'));
    expect(g).toMatchObject({ models: { image_description: 'magpie/vision/model' } });
  });
  it('names the offending model and field instead of a generic catalog error', async () => {
    const invalid: typeof fetch = async (input, init) =>
      String(input).endsWith('/models')
        ? Response.json({ data: [{ id: 'ok/model' }, { id: 'broken/model', context_window: 0 }] })
        : fetcher(input, init);
    await expect(readMagpieModels(gateway, undefined, invalid)).rejects.toThrow(
      'data[1] broken/model: context_window'
    );
  });
  it('rejects an oversized response without accepting a partial catalog', async () => {
    const oversized: typeof fetch = async () => new Response('x'.repeat(2 * 1024 * 1024 + 1));
    await expect(readMagpieModels(gateway, undefined, oversized)).rejects.toThrow('too large');
  });
});
