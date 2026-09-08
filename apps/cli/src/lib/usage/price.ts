// https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json

export type Price = {
    inputCostPerToken: number;
    outputCostPerToken: number;
    cacheReadInputTokenCost: number;
}

export const PRICE_DATA: { [key: string]: Price } = {
    'gpt-6-astra': {
        inputCostPerToken: 1e-05,
        cacheReadInputTokenCost: 1e-06,
        outputCostPerToken: 5e-05
    },
    'gpt-5.6': {
        inputCostPerToken: 5e-06,
        cacheReadInputTokenCost: 5e-07,
        outputCostPerToken: 3e-05
    },
    'gpt-5.6-sol': {
        inputCostPerToken: 5e-06,
        cacheReadInputTokenCost: 5e-07,
        outputCostPerToken: 3e-05
    },
    'gpt-5.6-terra': {
        inputCostPerToken: 2.5e-06,
        cacheReadInputTokenCost: 2.5e-07,
        outputCostPerToken: 1.5e-05
    },
    'gpt-5.6-luna': {
        inputCostPerToken: 1e-06,
        cacheReadInputTokenCost: 1e-07,
        outputCostPerToken: 6e-06
    },
    'gpt-5.5': {
        inputCostPerToken: 5e-06,
        cacheReadInputTokenCost: 5e-07,
        outputCostPerToken: 3e-05
    },
    'gpt-5.4': {
        inputCostPerToken: 2.5e-06,
        cacheReadInputTokenCost: 2.5e-07,
        outputCostPerToken: 1.5e-05
    },
    'gpt-5.3-codex-spark': {
        inputCostPerToken: 1.75e-06,
        cacheReadInputTokenCost: 1.75e-07,
        outputCostPerToken: 1.4e-05
    },
    'gpt-5.3-codex': {
        inputCostPerToken: 1.75e-06,
        cacheReadInputTokenCost: 1.75e-07,
        outputCostPerToken: 1.4e-05
    },
    'gpt-5.2-codex': {
        inputCostPerToken: 1.75e-06,
        cacheReadInputTokenCost: 1.75e-07,
        outputCostPerToken: 1.4e-05
    },
    'gpt-5.1-codex': {
        inputCostPerToken: 1.25e-06,
        cacheReadInputTokenCost: 1.25e-07,
        outputCostPerToken: 1e-05
    },
    'gpt-5.1-codex-max': {
        inputCostPerToken: 1.25e-06,
        cacheReadInputTokenCost: 1.25e-07,
        outputCostPerToken: 1e-05
    },
    'gpt-5.1-codex-mini': {
        inputCostPerToken: 2.5e-07,
        cacheReadInputTokenCost: 2.5e-08,
        outputCostPerToken: 2e-06
    },
    'gpt-5.2': {
        inputCostPerToken: 1.75e-06,
        cacheReadInputTokenCost: 1.75e-07,
        outputCostPerToken: 1.4e-05
    },
    // https://www.kimi.com/resources/kimi-k2-7-code-pricing
    'kimi-for-coding': {
        inputCostPerToken: 0.95e-06,
        cacheReadInputTokenCost: 0.19e-06,
        outputCostPerToken: 4e-06
    },
    'kimi-for-coding-highspeed': {
        inputCostPerToken: 0.95e-06,
        cacheReadInputTokenCost: 0.19e-06,
        outputCostPerToken: 8e-06
    }
}
