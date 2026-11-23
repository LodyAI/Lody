import { describe, expect, it } from 'vitest';
import { resolveAgentBrandId, type AgentBrandId } from '../src/agent-brand';

describe('resolveAgentBrandId', () => {
  it('prefers an explicit brandId over env', () => {
    expect(
      resolveAgentBrandId({
        brandId: 'minimax',
        env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' },
      })
    ).toBe('minimax');
  });

  it('falls back to ANTHROPIC_BASE_URL host when brandId is absent', () => {
    const cases: Array<[string, AgentBrandId]> = [
      ['https://api.deepseek.com/anthropic', 'deepseek'],
      ['https://api.xiaomimimo.com/anthropic', 'mimo'],
      ['https://token-plan-cn.xiaomimimo.com/anthropic', 'mimo'],
      ['https://api.minimaxi.com/anthropic', 'minimax'],
      ['https://api.minimax.io/anthropic', 'minimax'],
      ['https://open.bigmodel.cn/api/anthropic', 'glm'],
      ['https://api.z.ai/api/anthropic', 'glm'],
    ];
    for (const [url, expected] of cases) {
      expect(resolveAgentBrandId({ env: { ANTHROPIC_BASE_URL: url } })).toBe(expected);
    }
  });

  it('returns undefined for unknown / missing base URLs', () => {
    expect(resolveAgentBrandId({})).toBeUndefined();
    expect(resolveAgentBrandId({ env: {} })).toBeUndefined();
    expect(
      resolveAgentBrandId({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } })
    ).toBeUndefined();
    expect(resolveAgentBrandId({ env: { ANTHROPIC_BASE_URL: 'not-a-url' } })).toBeUndefined();
  });

  it('does not match a lookalike host that merely contains a brand substring', () => {
    // `deepseek.com.evil.example` must NOT resolve to deepseek.
    expect(
      resolveAgentBrandId({
        env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com.evil.example/anthropic' },
      })
    ).toBeUndefined();
  });
});
