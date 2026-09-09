import {
  ACP_CAPABILITY_CACHE_VERSION,
  CURSOR_PARAMETERIZED_MODEL_PICKER_SOURCE_VERSION_SUFFIX,
  type AcpConfigOptionSummary,
  type MachineViewMeta,
} from '@lody/shared';

export const cursorThinkingOption = (): AcpConfigOptionSummary => ({
  id: 'thinking',
  name: 'Thinking',
  category: 'thought_level',
  type: 'select',
  currentValue: 'false',
  options: [
    { value: 'false', name: 'False' },
    { value: 'true', name: 'True' },
  ],
});

export const cursorReasoningOption = (): AcpConfigOptionSummary => ({
  id: 'reasoning',
  name: 'Reasoning',
  category: 'thought_level',
  type: 'select',
  currentValue: 'low',
  options: [
    { value: 'low', name: 'Low' },
    { value: 'medium', name: 'Medium' },
    { value: 'high', name: 'High' },
  ],
});

export const cursorModelOption = (): AcpConfigOptionSummary => ({
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'a',
  options: [
    { value: 'a', name: 'A' },
    { value: 'b', name: 'B' },
  ],
});

export function cursorParameterizedModelCapabilityEntry(
  cliType: 'registry' | 'builtin',
  agentType: string
): NonNullable<MachineViewMeta['acpCapabilities']>[string] {
  const thinking = cursorThinkingOption();
  return {
    cliType,
    agentType,
    cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
    provenance: 'runtime',
    ...(cliType === 'registry' && agentType === 'cursor'
      ? {
          sourceVersion: `cursor@2026.08.31${CURSOR_PARAMETERIZED_MODEL_PICKER_SOURCE_VERSION_SUFFIX}`,
        }
      : {}),
    modes: [],
    models: [],
    configOptions: [cursorModelOption(), thinking],
    configOptionsByModel: {
      a: [thinking],
      b: [cursorReasoningOption()],
    },
    fetchedAt: 1,
  };
}
