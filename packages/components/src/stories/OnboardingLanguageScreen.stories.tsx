import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import type { SupportedLanguage } from '@lody/shared';
import { LanguageScreenView, OnboardingBackdrop } from '@/components/onboarding';
const storyLayout = stylex.create({
  frame: {
    position: 'relative',
    'min-height': '680px',
    width: '100%',
  },
  row: {
    position: 'relative',
    'z-index': '10',
    display: 'flex',
    'min-height': '680px',
    'align-items': 'center',
    'justify-content': 'center',
    padding: 'calc(var(--spacing) * 8)',
  },
});

function LanguagePreviewWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div {...stylex.props(storyLayout.frame)}>
      <OnboardingBackdrop />
      <div {...stylex.props(storyLayout.row)}>{children}</div>
    </div>
  );
}

/** Thin controlled wrapper so Storybook can interactively flip between options. */
function InteractiveLanguageScreen({
  initial,
  onNext,
}: {
  initial: SupportedLanguage;
  onNext: () => void;
}) {
  const [value, setValue] = useState<SupportedLanguage>(initial);
  return <LanguageScreenView value={value} onChange={setValue} onNext={onNext} />;
}

const meta = {
  title: 'Onboarding/LanguageScreen',
  component: LanguageScreenView,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    onChange: fn(),
    onNext: fn(),
  },
  decorators: [
    (Story) => (
      <LanguagePreviewWrapper>
        <Story />
      </LanguagePreviewWrapper>
    ),
  ],
} satisfies Meta<typeof LanguageScreenView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const English: Story = {
  args: {
    value: 'en',
  },
};

export const Chinese: Story = {
  args: {
    value: 'zh_CN',
  },
};

export const Interactive: Story = {
  render: (args) => <InteractiveLanguageScreen initial={args.value} onNext={args.onNext} />,
  args: {
    value: 'en',
  },
};
