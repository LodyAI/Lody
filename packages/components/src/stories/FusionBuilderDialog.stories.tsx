import type { Meta, StoryObj } from '@storybook/react';
import { FusionBuilderDialog } from '@/components/sessions/fusion-builder-dialog';
import {
  parseFusionCatalog,
  type FusionControls,
  type FusionControlsResolver,
  type FusionModelOption,
} from '@/lib/devin-fusion';

/* Synthetic Devin 3000.x model list: three leads, three sidekicks, one pair
   without Fast (Claude Fable), one unadvertised combination. */
const MODEL_OPTIONS: FusionModelOption[] = [
  { value: 'adaptive', label: 'Adaptive' },
  {
    value: 'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium',
    label: 'Fusion (Claude Opus 5.5 Medium + SWE-2 Medium)',
  },
  {
    value: 'fusion-claude-opus-5-5-medium-sidekick-swe-2-high',
    label: 'Fusion (Claude Opus 5.5 Medium + SWE-2 High)',
  },
  {
    value: 'fusion-claude-opus-5-5-medium-sidekick-glm-5-2',
    label: 'Fusion (Claude Opus 5.5 Medium + GLM-5.2 High)',
  },
  {
    value: 'fusion-gpt-6-astra-high-sidekick-swe-2-medium',
    label: 'Fusion (GPT-6 Astra High Thinking + SWE-2 Medium)',
  },
  {
    value: 'fusion-claude-fable-5-2-high-sidekick-swe-2-medium',
    label: 'Fusion (Claude Fable 5.2 High + SWE-2 Medium)',
  },
];

const catalog = parseFusionCatalog(MODEL_OPTIONS);
if (!catalog) throw new Error('story fixture must parse');

const EFFORT = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];
const FABLE = 'fusion-claude-fable-5-2-high-sidekick-swe-2-medium';
const OPUS = 'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium';

const baseControls = (modelValue: string): FusionControls => ({
  effort:
    modelValue === FABLE
      ? {
          configId: 'thought_level',
          options: [{ value: 'high', label: 'High' }],
          defaultValue: 'high',
        }
      : { configId: 'thought_level', options: EFFORT, defaultValue: 'medium' },
  fast: modelValue === FABLE ? null : { configId: 'speed', onValue: 'fast', offValue: 'standard' },
  unknown: { effort: false, fast: false },
});

const controlsFor: FusionControlsResolver = baseControls;
const unknownControls: FusionControlsResolver = () => ({
  effort: null,
  fast: null,
  unknown: { effort: true, fast: true },
});

const meta = {
  title: 'Sessions/FusionBuilderDialog',
  component: FusionBuilderDialog,
  args: {
    open: true,
    onOpenChange: () => {},
    catalog,
    controlsFor,
    appliesOn: 'nextMessage',
    modelLabel: (value: string) =>
      MODEL_OPTIONS.find((option) => option.value === value)?.label ?? value,
    onApply: () => {},
    runtime: null,
  },
} satisfies Meta<typeof FusionBuilderDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ConfirmedPair: Story = {
  args: {
    current: { modelId: OPUS, configOptionValues: { thought_level: 'high', speed: 'fast' } },
    runtime: { modelId: OPUS, configOptionValues: { thought_level: 'high', speed: 'fast' } },
  },
};

export const NonFusionModel: Story = {
  args: { current: { modelId: 'adaptive', configOptionValues: {} } },
};

export const PairWithoutFast: Story = {
  args: {
    current: { modelId: FABLE, configOptionValues: { thought_level: 'high' } },
    runtime: { modelId: 'adaptive', configOptionValues: {} },
    appliesOn: 'conversationStart',
  },
};

export const UnknownControls: Story = {
  args: {
    controlsFor: unknownControls,
    current: { modelId: 'adaptive', configOptionValues: {} },
  },
};

export const RuntimeDiffers: Story = {
  args: {
    current: { modelId: OPUS, configOptionValues: { thought_level: 'medium' } },
    runtime: {
      modelId: 'fusion-claude-opus-5-5-medium-sidekick-glm-5-2',
      configOptionValues: { thought_level: 'high', speed: 'fast' },
    },
  },
};
