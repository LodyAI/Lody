import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button, type ButtonProps } from '@lody/ui/button';
import { button } from '@lody/ui/button/button.tokens.stylex';
import { messageActionLabelTheme } from '../style/message-action-button.stylex';

const styles = stylex.create({
  frame: { padding: 20, minHeight: '100vh' },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 },
  scope: { [button.text]: '17px', [button.textMini]: '11px', [button.radiusSmall]: '9px' },
});

type Stage = 'named' | 'xs' | 'zero';
const typography = {
  named: {},
  xs: {
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--tw-leading, var(--text-xs--line-height))',
  },
  zero: { fontSize: 0, lineHeight: 0 },
} satisfies Record<Stage, Pick<ButtonProps, 'fontSize' | 'lineHeight'>>;

function Fixture() {
  const [stage, setStage] = useState<Stage>('named');
  const [disabled, setDisabled] = useState(false);
  const [activations, setActivations] = useState(0);
  return (
    <main {...stylex.props(styles.frame)} data-button-typography data-stage={stage}>
      <div {...stylex.props(styles.row)} data-typography-defaults>
        {(['mini', 'small', 'medium', 'large'] as const).map((size) => (
          <Button key={size} size={size} data-typography-named={size}>
            {size}
          </Button>
        ))}
      </div>
      <section {...stylex.props(styles.scope)} data-typography-scope>
        <div {...stylex.props(styles.row)}>
          <Button
            variant="ghost"
            size="small"
            {...typography[stage]}
            className={stylex.props(messageActionLabelTheme).className}
            disabled={disabled}
            aria-label="Typography target"
            data-typography-target
            onClick={() => setActivations((value) => value + 1)}
          >
            Typography target
          </Button>
          <Button fontSize={18} lineHeight={1.25} data-typography-numeric>
            Numeric typography
          </Button>
          <Button
            {...typography[stage]}
            style={{ fontSize: '29px', lineHeight: '39px' }}
            data-typography-style
          >
            Direct style follows existing Button behavior
          </Button>
          <Button
            {...typography[stage]}
            style={() => ({ fontSize: '29px', lineHeight: '39px' })}
            data-typography-style-callback
          >
            Direct callback follows existing Button behavior
          </Button>
          <Button
            nativeButton={false}
            {...typography[stage]}
            render={<a href="#typography" style={{ fontSize: '21px', lineHeight: '31px' }} />}
            data-typography-render
            onClick={(event) => event.preventDefault()}
          >
            Rendered inline constraint
          </Button>
        </div>
        <div {...stylex.props(styles.row)}>
          <button type="button" onClick={() => setStage('xs')}>
            Apply typography
          </button>
          <button type="button" onClick={() => setStage('zero')}>
            Zero typography
          </button>
          <button type="button" onClick={() => setStage('named')}>
            Omit typography
          </button>
          <button type="button" onClick={() => setDisabled((value) => !value)}>
            Toggle disabled
          </button>
        </div>
      </section>
      <output data-typography-activations>{activations}</output>
    </main>
  );
}

const meta = {
  title: 'Migration/OwnedButtonTypography',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Contract: Story = { render: () => <Fixture /> };
