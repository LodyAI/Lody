import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { AgentIcon } from '@/components/icons/agent-icon';
import { MobileRunConfigButton } from '@/components/mobile/mobile-run-config-button';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
const storyLayoutStylesStyles = stylex.create({
  frame: {
    width: '360px',
    'border-radius': 'var(--radius-2xl)',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 4)',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
  },
});

const storyLayoutStyles = stylex.create({
  caption: {
    'margin-bottom': 'calc(var(--spacing) * 3)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wide)',
    color: 'hsl(var(--muted-foreground) / 1)',
    'text-transform': 'uppercase',
  },
});

const storyLayout = stylex.create({
  row: {
    display: 'flex',
    'min-height': '100dvh',
    'align-items': 'flex-start',
    'justify-content': 'center',
    'background-color': 'var(--color-stone-950)',
    padding: 'calc(var(--spacing) * 6)',
  },
  stack: {
    display: 'flex',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 3)',
  },
  stack2: {
    display: 'flex',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  caption: {
    'font-size': '11px',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  row2: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
});

const codexIcon = <AgentIcon cliType="builtin" agentType="codex" />;
const claudeIcon = <AgentIcon cliType="builtin" agentType="claude" />;
const minimaxIcon = <AgentIcon cliType="builtin" agentType="minimax" brandId="minimax" />;
const glmIcon = <AgentIcon cliType="builtin" agentType="glm" brandId="glm" />;

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
    <div {...stylex.props(storyLayout.row)}>
      <div {...stylex.props(storyLayoutStylesStyles.frame)}>
        <div {...stylex.props(storyLayoutStyles.caption)}>Run config button — face states</div>
        <div {...stylex.props(storyLayout.stack)}>
          {CASES.map((c) => (
            <div key={c.label} {...stylex.props(storyLayout.stack2)}>
              <div {...stylex.props(storyLayout.caption)}>{c.label}</div>
              <div {...stylex.props(storyLayout.row2)}>
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
