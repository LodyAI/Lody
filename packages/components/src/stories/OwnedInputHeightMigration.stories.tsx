import type { Meta, StoryObj } from '@storybook/react';
import { useRef, useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Input, type InputProps } from '@lody/ui/input';
import { PasswordInput } from '@lody/ui/password-input';
import { Button } from '@lody/ui/button';
import { Field } from '@lody/ui/field';

const styles = stylex.create({
  frame: { padding: 24, maxWidth: 520 },
  stack: { display: 'flex', flexDirection: 'column', gap: 16 },
  row: { display: 'flex', flexWrap: 'wrap', gap: 4 },
});
type Height = 'custom' | 'zero' | 'omitted';

function heightProps(height: Height) {
  return {
    controlHeight:
      height === 'custom' ? 'calc(var(--spacing) * 10)' : height === 'zero' ? 0 : undefined,
  };
}

function Control({
  kind = 'plain',
  height = 'custom',
  name,
  size = 'medium',
  style,
  nativeHeight,
  disabled = false,
}: {
  kind?: 'plain' | 'leading' | 'password';
  height?: Height;
  name: string;
  size?: InputProps['size'];
  style?: InputProps['style'];
  nativeHeight?: number;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('Retained value');
  const shared = {
    ...heightProps(height),
    ref,
    id: `input-height-${name}`,
    'data-height-input': name,
    size,
    style,
    height: nativeHeight,
    disabled,
    value,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
  };
  return (
    <div data-height-case={name} data-kind={kind} data-height={height} data-value={value}>
      <label htmlFor={shared.id}>{name}</label>
      {kind === 'password' ? (
        <PasswordInput {...shared} labels={{ show: `Show ${name}`, hide: `Hide ${name}` }} />
      ) : (
        <Input
          {...shared}
          leading={kind === 'leading' ? <span data-leading-content>/</span> : undefined}
        />
      )}
    </div>
  );
}

function Fixture({ mode = 'matrix' }: { mode?: 'matrix' | 'scoped' | 'styles' | 'update' }) {
  const [height, setHeight] = useState<Height>('custom');
  return (
    <div
      data-input-height={mode}
      data-current-height={height}
      {...stylex.props(styles.frame, styles.stack)}
    >
      {mode === 'matrix' ? (
        <>
          {(['small', 'medium', 'large'] as const).map((size) => (
            <Control key={size} name={size} size={size} height="omitted" />
          ))}
          <Control name="plain" />
          <Control name="leading" kind="leading" />
          <Control name="password" kind="password" />
          <Field.Root disabled>
            <Control name="disabled" kind="password" />
          </Field.Root>
          <Field.Root invalid>
            <Control name="invalid" />
          </Field.Root>
        </>
      ) : mode === 'scoped' ? (
        <div style={{ '--spacing': '6px' } as CSSProperties} {...stylex.props(styles.stack)}>
          <Control name="root" />
          <Control name="element" style={{ '--spacing': '5px' } as CSSProperties} />
          <div style={{ '--spacing': '3px' } as CSSProperties} {...stylex.props(styles.stack)}>
            <Control name="subtree" kind="leading" />
            <Control name="subtree-password" kind="password" />
          </div>
        </div>
      ) : mode === 'styles' ? (
        <>
          <Control
            name="object"
            style={{ height: 46, color: 'rgb(90, 40, 120)' }}
            nativeHeight={17}
          />
          <Control
            name="callback"
            style={(state) => ({ height: state.disabled ? 19 : 44, letterSpacing: '1px' })}
            nativeHeight={18}
          />
          <Control
            name="leading-callback"
            kind="leading"
            style={() => ({ height: 22, letterSpacing: '1px' })}
            nativeHeight={19}
          />
          <Control
            name="password-callback"
            kind="password"
            style={() => ({ height: 23, letterSpacing: '1px' })}
            nativeHeight={20}
          />
          <Control
            name="disabled-callback"
            style={(state) => ({ height: state.disabled ? 19 : 44 })}
            nativeHeight={21}
            disabled
          />
        </>
      ) : (
        <>
          <Control name="update-plain" height={height} />
          <Control name="update-leading" kind="leading" height={height} />
          <Control name="update-password" kind="password" height={height} />
          <div {...stylex.props(styles.row)}>
            <Button
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setHeight('zero')}
            >
              Zero well height
            </Button>
            <Button
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setHeight('omitted')}
            >
              Omit well height
            </Button>
            <Button
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setHeight('custom')}
            >
              Restore custom height
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedInputHeight',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Matrix: Story = {};
export const ScopedSpacing: Story = { args: { mode: 'scoped' } };
export const CallerStyles: Story = { args: { mode: 'styles' } };
export const MountedUpdates: Story = { args: { mode: 'update' } };
