import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Spinner, type SpinnerSize } from '@lody/ui/spinner';
import { Button } from '@lody/ui/button';
import { UserMessageEditor } from '@/components/ai-gui/user-message-editor';
import { PrMergeButton } from '@/components/sessions/pr-merge-button';
import { SettingsStoryProviders } from './settings-story-shell';
import { themeColors } from '../style/theme-colors.stylex';

const styles = stylex.create({
  frame: { padding: 16, color: themeColors.foreground, backgroundColor: themeColors.background },
  row: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16, marginBottom: 12 },
  sample: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12 },
  production: { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 },
});

function Sample({ name, children }: { name: string; children: ReactNode }) {
  return (
    <span data-spinner-sample={name} {...stylex.props(styles.sample)}>
      {name}
      {children}
    </span>
  );
}

function NamedSizesFixture() {
  return (
    <div {...stylex.props(styles.row)} data-spinner-dimensions="named">
      <Sample name="default">
        <Spinner />
      </Sample>
      {(['small', 'medium', 'large'] as SpinnerSize[]).map((size) => (
        <Sample key={size} name={size}>
          <Spinner size={size} />
        </Sample>
      ))}
      <Sample name="silent">
        <Spinner label={null} />
      </Sample>
    </div>
  );
}

function OverrideSizesFixture() {
  return (
    <div {...stylex.props(styles.row)} data-spinner-dimensions="overrides">
      <Sample name="sixteen">
        <Spinner
          diameter="calc(var(--spacing) * 4)"
          width={37}
          height={31}
          data-svg-probe="sixteen"
        />
      </Sample>
      <Sample name="fourteen">
        <Spinner size="large" diameter="calc(var(--spacing) * 3.5)" />
      </Sample>
      <Sample name="twentyfour">
        <Spinner size="small" diameter="calc(var(--spacing) * 6)" />
      </Sample>
    </div>
  );
}

function ScopedSpacingFixture() {
  return (
    <div style={{ '--spacing': '6px' } as CSSProperties} data-spinner-spacing="root">
      <OverrideSizesFixture />
      <div style={{ '--spacing': '3px' } as CSSProperties} data-spinner-spacing="subtree">
        <OverrideSizesFixture />
      </div>
    </div>
  );
}

function UpdateCycleFixture() {
  const [stage, setStage] = useState<'sixteen' | 'zero' | 'named' | 'fourteen'>('sixteen');
  const diameter =
    stage === 'sixteen'
      ? 'calc(var(--spacing) * 4)'
      : stage === 'zero'
        ? 0
        : stage === 'fourteen'
          ? 'calc(var(--spacing) * 3.5)'
          : undefined;
  return (
    <div data-spinner-update={stage}>
      <div {...stylex.props(styles.row)}>
        <Button onClick={() => setStage('zero')}>Zero diameter</Button>
        <Button onClick={() => setStage('named')}>Named size</Button>
        <Button onClick={() => setStage('fourteen')}>Fourteen diameter</Button>
      </div>
      <Spinner
        size={stage === 'named' ? 'large' : 'medium'}
        diameter={diameter}
        data-mounted-spinner=""
      />
      <output>{stage}</output>
    </div>
  );
}

function ProductionBusyControls() {
  return (
    <div {...stylex.props(styles.production)}>
      <UserMessageEditor
        value="Preserved busy draft."
        onChange={() => undefined}
        onCancel={() => undefined}
        onSave={() => undefined}
        isSaving
        conversationFontSize={14}
      />
      <PrMergeButton method="merge" compact isMerging onMerge={() => undefined} />
      <PrMergeButton method="merge" isMerging onMerge={() => undefined} />
    </div>
  );
}

function ProductionScopesFixture() {
  return (
    <div style={{ '--spacing': '6px' } as CSSProperties} data-spinner-production-scope="root">
      <ProductionBusyControls />
      <div style={{ '--spacing': '3px' } as CSSProperties} data-spinner-production-scope="subtree">
        <ProductionBusyControls />
      </div>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedSpinnerDimensions',
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <SettingsStoryProviders>
        <div {...stylex.props(styles.frame)}>
          <Story />
        </div>
      </SettingsStoryProviders>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const NamedSizes: Story = { render: () => <NamedSizesFixture /> };
export const Overrides: Story = { render: () => <OverrideSizesFixture /> };
export const ScopedSpacing: Story = { render: () => <ScopedSpacingFixture /> };
export const UpdateCycle: Story = { render: () => <UpdateCycleFixture /> };
export const ProductionScopes: Story = { render: () => <ProductionScopesFixture /> };
