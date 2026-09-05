// https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json

export type Price = {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadInputTokenCost: number;
};

export const PRICE_DATA: { [key: string]: Price } = {
  'gpt-5.6': {
    inputCostPerToken: 5e-6,
    cacheReadInputTokenCost: 5e-7,
    outputCostPerToken: 3e-5,
  },
  'gpt-5.6-sol': {
    inputCostPerToken: 5e-6,
    cacheReadInputTokenCost: 5e-7,
    outputCostPerToken: 3e-5,
  },
  'gpt-5.6-terra': {
    inputCostPerToken: 2.5e-6,
    cacheReadInputTokenCost: 2.5e-7,
    outputCostPerToken: 1.5e-5,
  },
  'gpt-5.6-luna': {
    inputCostPerToken: 1e-6,
    cacheReadInputTokenCost: 1e-7,
    outputCostPerToken: 6e-6,
  },
  'gpt-5.5': {
    inputCostPerToken: 5e-6,
    cacheReadInputTokenCost: 5e-7,
    outputCostPerToken: 3e-5,
  },
  'gpt-5.4': {
    inputCostPerToken: 2.5e-6,
    cacheReadInputTokenCost: 2.5e-7,
    outputCostPerToken: 1.5e-5,
  },
  'gpt-5.3-codex-spark': {
    inputCostPerToken: 1.75e-6,
    cacheReadInputTokenCost: 1.75e-7,
    outputCostPerToken: 1.4e-5,
  },
  'gpt-5.3-codex': {
    inputCostPerToken: 1.75e-6,
    cacheReadInputTokenCost: 1.75e-7,
    outputCostPerToken: 1.4e-5,
  },
  'gpt-5.2-codex': {
    inputCostPerToken: 1.75e-6,
    cacheReadInputTokenCost: 1.75e-7,
    outputCostPerToken: 1.4e-5,
  },
  'gpt-5.1-codex': {
    inputCostPerToken: 1.25e-6,
    cacheReadInputTokenCost: 1.25e-7,
    outputCostPerToken: 1e-5,
  },
  'gpt-5.1-codex-max': {
    inputCostPerToken: 1.25e-6,
    cacheReadInputTokenCost: 1.25e-7,
    outputCostPerToken: 1e-5,
  },
  'gpt-5.1-codex-mini': {
    inputCostPerToken: 2.5e-7,
    cacheReadInputTokenCost: 2.5e-8,
    outputCostPerToken: 2e-6,
  },
  'gpt-5.2': {
    inputCostPerToken: 1.75e-6,
    cacheReadInputTokenCost: 1.75e-7,
    outputCostPerToken: 1.4e-5,
  },
  // https://www.kimi.com/resources/kimi-k2-7-code-pricing
  'kimi-for-coding': {
    inputCostPerToken: 0.95e-6,
    cacheReadInputTokenCost: 0.19e-6,
    outputCostPerToken: 4e-6,
  },
  'kimi-for-coding-highspeed': {
    inputCostPerToken: 0.95e-6,
    cacheReadInputTokenCost: 0.19e-6,
    outputCostPerToken: 8e-6,
  },
};
