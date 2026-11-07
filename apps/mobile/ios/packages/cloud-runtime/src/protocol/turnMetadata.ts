export type TurnTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
};
export type TurnMetadata = {
  tokenUsage?: TurnTokenUsage;
  inputConfig?: {
    modeId?: string;
    configOptionValues?: Record<string, string | boolean>;
  };
};

/** History is peer data: malformed usage is absent, never a guessed zero. */
export function readTurnMetadata(entry: any): TurnMetadata {
  const usage = entry?.tokenUsage;
  const keys = [
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
    'reasoningOutputTokens',
  ] as const;
  let tokenUsage: TurnTokenUsage | undefined;
  if (
    usage &&
    keys.every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
  )
    tokenUsage = Object.fromEntries(
      keys.map((key) => [key, usage[key]]),
    ) as TurnTokenUsage;
  const input = entry?.inputConfig;
  const modeId =
    typeof input?.modeId === 'string' ? input.modeId.trim() : undefined;
  const options = input?.configOptionValues;
  const configOptionValues =
    options && typeof options === 'object' && !Array.isArray(options)
      ? (Object.fromEntries(
          Object.entries(options).filter(
            ([key, value]) =>
              key.length <= 160 &&
              !/secret|token|password|credential/i.test(key) &&
              (typeof value === 'boolean' ||
                (typeof value === 'string' && value.length <= 512)),
          ),
        ) as Record<string, string | boolean>)
      : undefined;
  return {
    tokenUsage,
    inputConfig:
      modeId || configOptionValues ? { modeId, configOptionValues } : undefined,
  };
}
