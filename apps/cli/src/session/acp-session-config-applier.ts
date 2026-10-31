import { Effect } from 'effect';
import type { AcpConfigOptionValue, AgentConfigCliType } from '@lody/shared';
import { AcpConfiguration, AcpConfigurationError } from '@/agent/acp-configuration';

export type AcpSessionRunConfig = {
  cliType?: AgentConfigCliType;
  agentType?: string;
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
};

/** All supplied values are requirements; only confirmed values may reach the next prompt. */
export const applyAcpSessionRunConfig = Effect.fnUntraced(function* (config: AcpSessionRunConfig) {
  const client = yield* AcpConfiguration;
  const modeOption = client.options.find((option) => option.category === 'mode');
  const modelOption = client.options.find((option) => option.category === 'model');
  const values = config.configOptionValues ?? {};
  const optionMode = modeOption ? values[modeOption.id] : undefined;
  const optionModel = modelOption ? values[modelOption.id] : undefined;
  const mode = config.modeId ?? (typeof optionMode === 'string' ? optionMode : undefined);
  const model = config.modelId ?? (typeof optionModel === 'string' ? optionModel : undefined);

  if (mode !== undefined) yield* client.setMode(mode);
  if (model !== undefined) yield* client.setModel(model);
  for (const [id, value] of Object.entries(values)) {
    if (id === modeOption?.id || id === modelOption?.id) continue;
    yield* client.setOption(id, value);
  }

  const confirmed = yield* client.read;
  if (mode !== undefined && confirmed.modeId !== mode) {
    return yield* Effect.fail(new AcpConfigurationError('mode', 'unconfirmed'));
  }
  if (model !== undefined && confirmed.modelId !== model) {
    return yield* Effect.fail(new AcpConfigurationError('model', 'unconfirmed'));
  }
  for (const [id, value] of Object.entries(values)) {
    if (id === modeOption?.id || id === modelOption?.id) continue;
    if (confirmed.configOptionValues?.[id] !== value) {
      return yield* Effect.fail(new AcpConfigurationError(id, 'unconfirmed'));
    }
  }
  return confirmed;
});
