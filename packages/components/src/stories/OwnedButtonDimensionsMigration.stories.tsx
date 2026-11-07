import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button, ButtonGroup, type ButtonSize, type ButtonVariant } from '@lody/ui/button';
import { themeColors } from '../style/theme-colors.stylex';

const styles = stylex.create({
  frame: { padding: 20, backgroundColor: themeColors.background, color: themeColors.foreground },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 },
});

function Glyph() {
  return (
    <svg viewBox="0 0 16 16" width="100%" height="100%" aria-hidden>
      <path d="M3 8h10M8 3v10" fill="none" stroke="currentColor" />
    </svg>
  );
}

function MatrixFixture() {
  const [activations, setActivations] = useState(0);
  return (
    <div
      data-button-dimensions="matrix"
      data-activations={activations}
      {...stylex.props(styles.frame)}
    >
      <div {...stylex.props(styles.row)}>
        {(['mini', 'small', 'medium', 'large'] as ButtonSize[]).map((size) => (
          <Button key={size} size={size} data-named-size={size}>
            {size}
          </Button>
        ))}
      </div>
      <div {...stylex.props(styles.row)}>
        {(['primary', 'secondary', 'ghost', 'destructive', 'link'] as ButtonVariant[]).map(
          (variant) => (
            <Button
              key={variant}
              variant={variant}
              size="large"
              height="calc(var(--spacing) * 7)"
              width="calc(var(--spacing) * 28)"
              data-dimension-variant={variant}
            >
              {variant}
            </Button>
          )
        )}
      </div>
      <div {...stylex.props(styles.row)}>
        <Button
          icon
          size="large"
          height="calc(var(--spacing) * 6)"
          width="calc(var(--spacing) * 6)"
          aria-label="Custom icon box"
          data-custom-icon
        >
          <Glyph />
        </Button>
        <Button
          shape="pill"
          height="calc(var(--spacing) * 7)"
          width="calc(var(--spacing) * 28)"
          data-custom-pill
        >
          Pill
        </Button>
        <ButtonGroup>
          <Button height="calc(var(--spacing) * 7)" width="calc(var(--spacing) * 24)">
            Segment
          </Button>
          <Button
            icon
            height="calc(var(--spacing) * 7)"
            width="calc(var(--spacing) * 7)"
            aria-label="Segment options"
          >
            <Glyph />
          </Button>
        </ButtonGroup>
        <Button
          disabled
          height="calc(var(--spacing) * 7)"
          width="calc(var(--spacing) * 28)"
          data-disabled-box
        >
          Disabled
        </Button>
        <Button
          variant="secondary"
          height="calc(var(--spacing) * 7)"
          width="calc(var(--spacing) * 28)"
          data-layout-action
          onClick={() => setActivations((n) => n + 1)}
        >
          Activate layout
        </Button>
      </div>
      <output>Activations: {activations}</output>
    </div>
  );
}

function ScopedFixture() {
  return (
    <div
      data-button-dimensions="scoped"
      style={{ '--spacing': '6px' } as CSSProperties}
      {...stylex.props(styles.frame)}
    >
      <style>
        {'[data-button-dimensions="scoped"] button[data-element-spacing] { --spacing: 5px; }'}
      </style>
      <div {...stylex.props(styles.row)}>
        <Button
          height="calc(var(--spacing) * 7)"
          width="calc(var(--spacing) * 24)"
          data-spacing-case="outer"
        >
          Outer6
        </Button>
      </div>
      <div style={{ '--spacing': '3px' } as CSSProperties} {...stylex.props(styles.row)}>
        <Button
          height="calc(var(--spacing) * 7)"
          width="calc(var(--spacing) * 24)"
          data-spacing-case="inner"
        >
          Inner3
        </Button>
        <Button
          height="calc(var(--spacing) * 7)"
          width="calc(var(--spacing) * 24)"
          data-spacing-case="element"
          data-element-spacing
        >
          Element5
        </Button>
      </div>
    </div>
  );
}

type Stage = 'override' | 'zero' | 'named' | 'rectangular' | 'disabled';
function UpdatesFixture() {
  const [stage, setStage] = useState<Stage>('override');
  const [clicks, setClicks] = useState(0);
  return (
    <div
      data-button-dimensions="updates"
      data-stage={stage}
      data-clicks={clicks}
      {...stylex.props(styles.frame)}
    >
      <div {...stylex.props(styles.row)}>
        <Button onClick={() => setStage('zero')}>Zero box</Button>
        <Button onClick={() => setStage('named')}>Named box</Button>
        <Button onClick={() => setStage('rectangular')}>Rectangular box</Button>
        <Button onClick={() => setStage('disabled')}>Disabled box</Button>
      </div>
      <Button
        icon
        aria-label="Mounted dimension target"
        data-dimension-target
        disabled={stage === 'disabled'}
        onClick={() => setClicks((n) => n + 1)}
        width={
          stage === 'zero'
            ? 0
            : stage === 'named'
              ? undefined
              : stage === 'rectangular' || stage === 'disabled'
                ? 'calc(var(--spacing) * 24)'
                : 'calc(var(--spacing) * 7)'
        }
        height={stage === 'zero' ? 0 : stage === 'named' ? undefined : 'calc(var(--spacing) * 7)'}
      >
        <Glyph />
      </Button>
      <output>Target clicks: {clicks}</output>
    </div>
  );
}

function CallerStylesFixture() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [clicks, setClicks] = useState(0);
  return (
    <div
      data-button-dimensions="caller"
      data-ref-tag={anchor?.tagName ?? 'pending'}
      data-clicks={clicks}
      {...stylex.props(styles.frame)}
    >
      <div {...stylex.props(styles.row)}>
        <Button
          data-rest-style
          height="calc(var(--spacing) * 7)"
          width="calc(var(--spacing) * 24)"
          style={{ width: 777, height: 99 }}
        >
          Rest style
        </Button>
        <Button
          ref={setAnchor}
          nativeButton={false}
          data-render-style
          height="calc(var(--spacing) * 7)"
          width="calc(var(--spacing) * 24)"
          render={<a href="#dimension-target" style={{ width: 105, height: 31 }} />}
          onClick={(event) => {
            event.preventDefault();
            setClicks((n) => n + 1);
          }}
        >
          Rendered link
        </Button>
      </div>
      <output>Rendered anchor clicks: {clicks}</output>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedButtonDimensions',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Matrix: Story = { render: () => <MatrixFixture /> };
export const ScopedLengths: Story = { render: () => <ScopedFixture /> };
export const MountedUpdates: Story = { render: () => <UpdatesFixture /> };
export const CallerStyles: Story = { render: () => <CallerStylesFixture /> };
