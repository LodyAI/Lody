import type { AcpConfigOptionSummary } from '@lody/shared';
import { resolveAcpConfigOptionsForModel } from '@lody/shared';

import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';

const thinking: AcpConfigOptionSummary = {
  id: 'thinking',
  name: 'Thinking',
  category: 'thought_level',
  type: 'select',
  currentValue: 'true',
  options: [
    { value: 'true', name: 'On' },
    { value: 'false', name: 'Off' },
  ],
};
const effort: AcpConfigOptionSummary = {
  id: 'effort',
  name: 'Effort',
  category: 'thought_level',
  type: 'select',
  currentValue: 'low',
  options: [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
  ],
};
const context: AcpConfigOptionSummary = {
  id: 'context',
  name: 'Context',
  category: 'model_config',
  type: 'select',
  currentValue: 'default',
  options: [{ value: 'default', name: 'Default' }],
};
const fast: AcpConfigOptionSummary = {
  id: 'fast',
  name: 'Fast',
  category: 'model_config',
  type: 'select',
  currentValue: 'false',
  options: [
    { value: 'true', name: 'On' },
    { value: 'false', name: 'Off' },
  ],
};
const reasoning: AcpConfigOptionSummary = {
  id: 'reasoning',
  name: 'Reasoning',
  category: 'thought_level',
  type: 'select',
  currentValue: 'minimal',
  options: [
    { value: 'minimal', name: 'Minimal' },
    { value: 'full', name: 'Full' },
  ],
};
const model: AcpConfigOptionSummary = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'a',
  options: [
    { value: 'a', name: 'A' },
    { value: 'b', name: 'B' },
  ],
};

const catalog = {
  configOptions: [model, thinking, effort, context, fast],
  configOptionsByModel: {
    a: [thinking, effort, context, fast],
    b: [reasoning],
  },
};

export const cursorParameterizedModelOptions: AcpSessionSelectOption[] = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
];

export const cursorParameterizedModelValues: Record<string, AcpConfigOptionValue> = {
  thinking: 'true',
  effort: 'low',
  context: 'default',
  fast: 'false',
};

export function cursorParameterizedModelSelectors(
  modelId: string | null | undefined
): AcpConfigOptionSelector[] {
  return (resolveAcpConfigOptionsForModel(catalog, modelId ?? undefined) ?? []).map((option) =>
    option.type === 'boolean'
      ? {
          type: 'boolean' as const,
          configId: option.id,
          label: option.name,
          category: option.category,
          currentValue: option.currentValue === true,
          options: [] as [],
        }
      : {
          type: 'select' as const,
          configId: option.id,
          label: option.name,
          category: option.category,
          currentValue: typeof option.currentValue === 'string' ? option.currentValue : '',
          options: option.options.map((entry) => ({
            value: entry.value,
            label: entry.name,
            description: entry.description,
          })),
        }
  );
}
