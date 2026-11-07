import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Slider } from '../ui/slider';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    minHeight: '100vh',
    padding: themeSpace[6],
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  column: {
    display: 'flex',
    width: 420,
    maxWidth: '100%',
    flexDirection: 'column',
    gap: themeSpace[6],
  },
  narrow: { width: 160 },
  row: { display: 'flex', flexDirection: 'column', gap: themeSpace[2] },
  output: { minHeight: 24, fontVariantNumeric: 'tabular-nums' },
});

const meta = { title: 'UI/SliderMigration', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Fixture({ fractional = false, disabled = false, narrow = false, degenerate = false }) {
  const [value, setValue] = useState(degenerate ? 5 : fractional ? 1.25 : 40);
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.column, narrow && styles.narrow)} data-slider-fixture>
        <label htmlFor="slider-migration-input">
          {fractional ? '缩放 Zoom' : degenerate ? 'Single allowed value' : 'Padding / 留白'}
        </label>
        <Slider
          id="slider-migration-input"
          value={value}
          onValueChange={setValue}
          min={degenerate ? 5 : fractional ? 1 : 0}
          max={degenerate ? 5 : fractional ? 3 : 100}
          step={fractional ? 0.01 : 5}
          disabled={disabled}
          aria-label="Migration slider"
        />
        <output data-slider-value {...stylex.props(styles.output)}>
          {value}
        </output>
        <button type="button" data-slider-after>
          After slider
        </button>
      </div>
    </div>
  );
}

export const Interactive: Story = { render: () => <Fixture /> };
export const Fractional: Story = { render: () => <Fixture fractional /> };
export const Disabled: Story = { render: () => <Fixture disabled /> };
export const Narrow: Story = { render: () => <Fixture narrow /> };
export const Degenerate: Story = { render: () => <Fixture degenerate /> };
export const Endpoints: Story = {
  render: () => (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.column)}>
        {[0, 25, 50, 100].map((value) => (
          <label key={value} {...stylex.props(styles.row)}>
            Value {value}
            <Slider
              value={value}
              onValueChange={() => {}}
              min={0}
              max={100}
              aria-label={`Static value ${value}`}
            />
          </label>
        ))}
      </div>
    </div>
  ),
};
