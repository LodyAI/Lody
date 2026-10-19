import { describe, expect, it } from 'vitest';
import {
  parseMagpieImportLink,
  magpieProviderSettings,
  normalizeMagpieGateway,
} from '../src/magpie-import';

const gateway = 'http://127.0.0.1:3425';
function payload() {
  return {
    kind: 'custom',
    id: 'magpie',
    name: 'Magpie',
    auth: { method: 'apiKey', apiKey: 'magpie-lody' },
    endpoints: [
      {
        protocol: 'anthropic-messages',
        baseUrl: gateway,
        targets: ['claude-code'],
        modelsUrl: `${gateway}/v1/models`,
      },
      {
        protocol: 'openai-responses',
        baseUrl: `${gateway}/v1`,
        targets: ['codex'],
        modelsUrl: `${gateway}/v1/models`,
      },
      {
        protocol: 'openai-chat',
        baseUrl: `${gateway}/v1`,
        targets: ['pi', 'dsh', 'kimi-code', 'grok', 'bub'],
        modelsUrl: `${gateway}/v1/models`,
      },
    ],
  };
}
const link = (value: unknown) =>
  `lody://provider/import?v=1&data=${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
describe('Magpie import contract', () => {
  it('decodes the runtime endpoints and creates distinct builtin configurations', () => {
    const result = parseMagpieImportLink(link(payload()));
    expect(result).toEqual({
      gatewayUrl: gateway,
      targets: ['claude', 'codex', 'pi', 'dsh', 'kimi', 'grok', 'bub'],
    });
    const configs = result.targets.map((t) => magpieProviderSettings(t, result.gatewayUrl));
    expect(configs.map((c) => c.name)).toEqual([
      'Claude-magpie',
      'Codex-magpie',
      'Pi-magpie',
      'DSH-magpie',
      'Kimi Code-magpie',
      'Grok-magpie',
      'Bub-magpie',
    ]);
    expect(configs.map((c) => c.agentType)).toEqual([
      'claude',
      'codex',
      'pi',
      'deepseek',
      'kimi',
      'grok',
      'bub',
    ]);
    expect(configs[0]?.env.ANTHROPIC_BASE_URL).toBe(gateway);
    expect(configs[1]?.env.OPENAI_BASE_URL).toBe(`${gateway}/v1`);
    expect(configs[2]?.magpieGatewayUrl).toBe(gateway);
    expect(configs[2]?.env).toEqual({});
    expect(configs.every((c) => c.magpieGatewayUrl === gateway)).toBe(true);
    expect(configs[3]?.env.DEEPSEEK_BASE_URL).toBe(`${gateway}/v1`);
  });
  it.each([
    'https://example.com',
    'http://192.168.1.2:3425',
    'http://127.1:3425',
    'http://2130706433',
    'http://user@localhost',
    'http://localhost/api',
    'http://localhost?x=1',
    'http://localhost/#fragment',
  ])('rejects noncanonical or nonlocal endpoints: %s', (url) => {
    expect(() => normalizeMagpieGateway(url)).toThrow();
  });
  it.each(['http://localhost:1234', 'http://[::1]:3425', gateway])(
    'allows explicit loopback: %s',
    (url) => {
      expect(normalizeMagpieGateway(url)).toBe(url);
    }
  );
  it('rejects secrets, extra launch fields, cross-origin model discovery and invalid target mappings', () => {
    const secret = payload();
    secret.auth.apiKey = 'secret';
    const remoteModels = payload();
    remoteModels.endpoints[0]!.modelsUrl = 'http://example.com/v1/models';
    const wrongTarget = payload();
    wrongTarget.endpoints[0]!.targets = ['codex'];
    const prototype = payload();
    prototype.endpoints[0]!.targets = ['__proto__'];
    const duplicate = payload();
    duplicate.endpoints[2]!.targets = ['pi', 'pi'];
    for (const value of [
      secret,
      remoteModels,
      wrongTarget,
      prototype,
      duplicate,
      { ...payload(), env: { NODE_OPTIONS: '--import=evil' } },
    ])
      expect(() => parseMagpieImportLink(link(value))).toThrow();
  });
  it('rejects unversioned, oversized and ambiguous links', () => {
    for (const url of [
      link(payload()).replace('v=1', 'v=2'),
      `${link(payload())}&v=1`,
      `${link(payload())}#x`,
      link(payload()).replace('provider/', 'user@provider/'),
      `lody://provider/import?v=1&data=${'a'.repeat(8192)}`,
    ])
      expect(() => parseMagpieImportLink(url)).toThrow();
  });
  it('only imports targets explicitly present in the link', () => {
    const value = payload();
    value.endpoints = [value.endpoints[1]!];
    expect(parseMagpieImportLink(link(value)).targets).toEqual(['codex']);
  });
});
