import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(config.model_providers.magpie).toMatchObject({
      base_url: `${gateway}/v1`,
      requires_openai_auth: false,
      wire_api: 'responses',
    });
    const catalog = JSON.parse(await readFile(config.model_catalog_json, 'utf8'));
    expect(catalog.models[0]).toMatchObject({
      slug: 'vendor/model',
      context_window: 64000,
      input_modalities: ['text', 'image'],
      default_reasoning_level: 'medium',
    });
    expect(codex.env.CODEX_HOME?.startsWith(directory)).toBe(true);
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
  it('rejects an oversized response without accepting a partial catalog', async () => {
    const oversized: typeof fetch = async () => new Response('x'.repeat(2 * 1024 * 1024 + 1));
    await expect(readMagpieModels(gateway, undefined, oversized)).rejects.toThrow('too large');
  });
  it('does not overwrite a previous Codex snapshot when models change', async () => {
    const directory = await root();
    const a = await prepareMagpieRuntime('codex', gateway, undefined, directory, fetcher);
    const next: typeof fetch = async (input, init) =>
      String(input).endsWith('/models')
        ? Response.json({ data: [{ id: 'next/model' }] })
        : fetcher(input, init);
    const b = await prepareMagpieRuntime('codex', gateway, undefined, directory, next);
    const before = JSON.parse(a.env.CODEX_CONFIG ?? '{}');
    const after = JSON.parse(b.env.CODEX_CONFIG ?? '{}');
    expect(before.model_catalog_json).not.toBe(after.model_catalog_json);
    expect(JSON.parse(await readFile(before.model_catalog_json, 'utf8')).models[0].slug).toBe(
      'vendor/model'
    );
  });
});
