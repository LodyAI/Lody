import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { resolveAcpConfigOptionsForModel, type AcpConfigOptionSummary } from '@lody/shared';

import { AgentIcon } from '@/components/icons/agent-icon';
import { MobileRunConfigButton } from '@/components/mobile/mobile-run-config-button';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';

const codexIcon = <AgentIcon cliType="builtin" agentType="codex" />;
const claudeIcon = <AgentIcon cliType="builtin" agentType="claude" />;
const minimaxIcon = <AgentIcon cliType="builtin" agentType="minimax" brandId="minimax" />;
const glmIcon = <AgentIcon cliType="builtin" agentType="glm" brandId="glm" />;
const cursorIcon = <AgentIcon cliType="registry" agentType="cursor" />;

const codexModeSelector: AcpConfigOptionSelector = {
  type: 'select',
  configId: 'mode',
  category: 'mode',
  label: 'Mode',
  currentValue: 'agent',
  options: [
    { value: 'read-only', label: 'Read-only' },
    { value: 'agent', label: 'Agent' },
    { value: 'agent-full-access', label: 'Full access' },
  ],
};
const reasoningSelector: AcpConfigOptionSelector = {
  type: 'select',
  configId: 'reasoning_effort',
  category: 'thought_level',
  label: 'Reasoning effort',
  currentValue: 'medium',
  options: [
    { value: 'low', label: 'low' },
    { value: 'medium', label: 'medium' },
    { value: 'high', label: 'high' },
  ],
};
const planSelector: AcpConfigOptionSelector = {
  type: 'select',
  configId: 'collaboration_mode',
  category: 'collaboration_mode',
  label: 'Collaboration mode',
  currentValue: 'default',
  options: [
    { value: 'default', label: 'Default' },
    { value: 'plan', label: 'Plan' },
  ],
};
const fastSelector: AcpConfigOptionSelector = {
  type: 'select',
  configId: 'fast-mode',
  category: 'fast-mode',
  label: 'Fast mode',
  currentValue: 'off',
  options: [
    { value: 'off', label: 'Off' },
    { value: 'on', label: 'On' },
  ],
};
const claudeModeSelector: AcpConfigOptionSelector = {
  type: 'select',
  configId: 'mode',
  category: 'mode',
  label: 'Mode',
  currentValue: 'default',
  options: [
    { value: 'auto', label: 'Auto' },
    { value: 'default', label: 'Default' },
    { value: 'acceptEdits', label: 'Accept Edits' },
    { value: 'plan', label: 'Plan Mode' },
    { value: 'dontAsk', label: "Don't Ask" },
  ],
};

const cursorThinking: AcpConfigOptionSummary = {
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
const cursorEffort: AcpConfigOptionSummary = {
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
const cursorContext: AcpConfigOptionSummary = {
  id: 'context',
  name: 'Context',
  category: 'model_config',
  type: 'select',
  currentValue: 'default',
  options: [{ value: 'default', name: 'Default' }],
};
const cursorFast: AcpConfigOptionSummary = {
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
const cursorCatalogEntry = {
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select' as const,
      currentValue: 'a',
      options: [
        { value: 'a', name: 'A' },
        { value: 'b', name: 'B' },
      ],
    },
    cursorThinking,
    cursorEffort,
    cursorContext,
    cursorFast,
  ],
  configOptionsByModel: {
    a: [cursorThinking, cursorEffort, cursorContext, cursorFast],
    b: [
      {
        id: 'reasoning',
        name: 'Reasoning',
        category: 'thought_level',
        type: 'select' as const,
        currentValue: 'minimal',
        options: [
          { value: 'minimal', name: 'Minimal' },
          { value: 'full', name: 'Full' },
        ],
      },
    ],
  },
};
const cursorSelectors: AcpConfigOptionSelector[] = (
  resolveAcpConfigOptionsForModel(cursorCatalogEntry, 'a') ?? []
).map((option) =>
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
const cursorValues: Record<string, AcpConfigOptionValue> = {
  thinking: 'true',
  effort: 'low',
  context: 'default',
  fast: 'false',
};
const cursorModelOptions: AcpSessionSelectOption[] = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
];

type Case = {
  label: string;
  model: string;
  agentIcon: ReactNode;
  modelOptions?: AcpSessionSelectOption[];
  selectors: AcpConfigOptionSelector[];
  values: Record<string, AcpConfigOptionValue>;
};

const CASES: Case[] = [
  {
    label: 'Codex · reasoning · default mode hidden',
    model: 'gpt-5.5',
    agentIcon: codexIcon,
    selectors: [codexModeSelector, reasoningSelector, planSelector, fastSelector],
    values: { mode: 'agent', reasoning_effort: 'medium' },
  },
  {
    label: 'Codex · Plan on',
    model: 'gpt-5.5',
    agentIcon: codexIcon,
    selectors: [codexModeSelector, planSelector, fastSelector],
    values: { mode: 'agent', collaboration_mode: 'plan' },
  },
  {
    label: 'Codex · Plan + Fast',
    model: 'gpt-5.5',
    agentIcon: codexIcon,
    selectors: [codexModeSelector, planSelector, fastSelector],
    values: { mode: 'agent', collaboration_mode: 'plan', 'fast-mode': 'on' },
  },
  {
    label: 'Codex · Read-only',
    model: 'gpt-5.5',
    agentIcon: codexIcon,
    selectors: [codexModeSelector, planSelector, fastSelector],
    values: { mode: 'read-only' },
  },
  {
    label: 'Codex · Full access (amber warning)',
    model: 'gpt-5.5',
    agentIcon: codexIcon,
    selectors: [codexModeSelector, planSelector, fastSelector],
    values: { mode: 'agent-full-access', 'fast-mode': 'on' },
  },
  {
    label: 'Claude · Auto (text label, no plan/fast)',
    model: 'Opus 4.8',
    agentIcon: claudeIcon,
    selectors: [claudeModeSelector],
    values: { mode: 'auto' },
  },
  {
    label: 'Claude · Accept Edits',
    model: 'Opus 4.8',
    agentIcon: claudeIcon,
    selectors: [claudeModeSelector],
    values: { mode: 'acceptEdits' },
  },
  {
    label: 'Claude · default — mode hidden',
    model: 'Opus 4.8',
    agentIcon: claudeIcon,
    selectors: [claudeModeSelector],
    values: { mode: 'default' },
  },
  {
    label: 'Long third-party model name',
    model: 'MiniMax Token Plan (minimaxi.com)/MiniMax-M3',
    agentIcon: minimaxIcon,
    selectors: [],
    values: {},
  },
  {
    label: 'Registry Cursor catalog',
    model: 'a',
    agentIcon: cursorIcon,
    modelOptions: cursorModelOptions,
    selectors: cursorSelectors,
    values: cursorValues,
  },
  {
    label: 'Unknown third-party mode — hidden',
    model: 'glm-4.6',
    agentIcon: glmIcon,
    selectors: [
      {
        ...codexModeSelector,
        options: [
          {
            value: 'vendor-super-cautious-review-first',
            label: 'Super cautious review-first mode',
          },
        ],
      },
    ],
    values: { mode: 'vendor-super-cautious-review-first' },
  },
];

function AllStates() {
  return (
    <div className="flex min-h-dvh items-start justify-center bg-stone-950 p-6">
      <div className="w-[360px] rounded-2xl bg-background p-4 shadow-2xl">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Run config button — face states
        </div>
        <div className="flex flex-col gap-3">
          {CASES.map((c) => (
            <div key={c.label} className="flex flex-col gap-1.5">
              <div className="text-[11px] text-muted-foreground">{c.label}</div>
              <div className="flex items-center gap-2">
                <MobileRunConfigButton
                  agentIcon={c.agentIcon}
                  modelOptions={c.modelOptions ?? [{ value: c.model, label: c.model }]}
                  selectedModelId={c.model}
                  modeOptions={[]}
                  selectedModeId={null}
                  configOptionSelectors={c.selectors}
                  configOptionValues={c.values}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileRunConfigButton',
  component: AllStates,
  parameters: { layout: 'fullscreen' },
  globals: { theme: 'dark' },
  tags: ['autodocs'],
} satisfies Meta<typeof AllStates>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FaceStates: Story = {};

export const RegistryCursorCatalog: Story = {
  render: () => (
    <MobileRunConfigButton
      agentIcon={cursorIcon}
      modelOptions={cursorModelOptions}
      selectedModelId="a"
      modeOptions={[]}
      selectedModeId={null}
      configOptionSelectors={cursorSelectors}
      configOptionValues={cursorValues}
    />
  ),
};
