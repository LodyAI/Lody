import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import { Button, type ButtonVariant } from '@lody/ui/button';
import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  frame: { padding: 20, color: 'rgb(36, 107, 83)' },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 16 },
});

const values = {
  omitted: undefined,
  explicit: 'rgb(180, 20, 40)',
  inherit: 'inherit',
  initial: 'initial',
  unset: 'unset',
  current: 'currentColor',
  fallback: 'var(--missing-label-color, inherit)',
  revert: 'revert',
  layer: 'revert-layer',
} satisfies Record<string, CSSProperties['color']>;

function Fixture() {
  const [mode, setMode] = useState<keyof typeof values>('omitted');
  const [variant, setVariant] = useState<ButtonVariant>('secondary');
  const [disabled, setDisabled] = useState(false);
  const [activations, setActivations] = useState(0);
  const color = values[mode];
  return (
    <main {...stylex.props(styles.frame)} data-label-color-contract data-mode={mode}>
      <label>
        Ink value
        <select
          value={mode}
          onChange={(event) => setMode(event.target.value as keyof typeof values)}
        >
          {Object.keys(values).map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <label>
        Variant
        <select
          value={variant}
          onChange={(event) => setVariant(event.target.value as ButtonVariant)}
        >
          {(['primary', 'secondary', 'ghost', 'solid', 'destructive', 'link'] as const).map(
            (value) => (
              <option key={value}>{value}</option>
            )
          )}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={disabled}
          onChange={(event) => setDisabled(event.target.checked)}
        />
        Disabled
      </label>
      <div {...stylex.props(styles.row)}>
        <Button
          variant={variant}
          labelColor={color}
          disabled={disabled}
          data-label-color-target
          onClick={() => setActivations((value) => value + 1)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path d="M3 8h10M8 3v10" stroke="currentColor" fill="none" />
          </svg>
          Constant ink
        </Button>
        <Button variant={variant} disabled={disabled} data-label-color-default>
          Palette reference
        </Button>
        <button type="button" tabIndex={-1} style={{ color }} data-label-color-native>
          Browser color reference
        </button>
        <Button
          nativeButton={false}
          labelColor={color}
          render={<a href="#color" style={{ color: 'rgb(51, 68, 85)' }} />}
          data-label-color-render
          onClick={(event) => event.preventDefault()}
        >
          Rendered color
        </Button>
      </div>
      <output data-label-color-activations>{activations}</output>
    </main>
  );
}

export default {
  title: 'Migration/OwnedButtonLabelColor',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
type Story = StoryObj;
export const Contract: Story = { render: () => <Fixture /> };
