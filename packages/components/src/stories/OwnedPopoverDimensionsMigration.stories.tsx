import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
import { PopupContainerProvider } from '@lody/ui/popup-container';
import { ThemeRoot } from '@lody/ui/theme';

const styles = stylex.create({
  frame: { padding: 16, minHeight: 540 },
  host: { position: 'relative', transform: 'translateX(4px)' },
});

type Size = 'default' | 'bounded' | 'zero';
const dimensions = {
  default: {},
  bounded: {
    width: 'calc(var(--spacing) * 72)',
    minWidth: 200,
    maxWidth: 'calc(100vw - 2rem)',
    maxHeight: 'calc(var(--spacing) * 32)',
  },
  zero: { width: 0, minWidth: 0, maxWidth: 0, maxHeight: 0 },
};

function DimensionsFixture({
  scoped = false,
  update = false,
  initialSize = 'bounded',
}: {
  scoped?: boolean;
  update?: boolean;
  initialSize?: Size;
}) {
  const [size, setSize] = useState<Size>(initialSize);
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState('Retained value');
  const [positioner, setPositioner] = useState<HTMLDivElement | null>(null);
  const [owner, setOwner] = useState('none');
  useLayoutEffect(() => {
    if (!scoped) return undefined;
    const root = document.documentElement;
    const prior = root.style.getPropertyValue('--spacing');
    const priority = root.style.getPropertyPriority('--spacing');
    root.style.setProperty('--spacing', '5px');
    return () => {
      if (prior) root.style.setProperty('--spacing', prior, priority);
      else root.style.removeProperty('--spacing');
    };
  }, [scoped]);
  return (
    <div
      data-popup-dimensions
      data-size={size}
      data-scoped={scoped}
      data-owner={owner}
      {...stylex.props(styles.frame)}
    >
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger render={<Button />}>Open sized panel</Popover.Trigger>
        <Popover.Content
          ref={setPositioner}
          align="start"
          padding="none"
          {...dimensions[size]}
          data-dimensions-positioner
          style={{ minWidth: 111 }}
          onPointerEnter={(event) =>
            setOwner(event.currentTarget === positioner ? 'positioner' : 'other')
          }
        >
          <Popover.Title>Sized panel</Popover.Title>
          <input
            aria-label="Retained value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          {update ? (
            <div>
              <Button size="small" onClick={() => setSize('default')}>
                Default dimensions
              </Button>
              <Button size="small" onClick={() => setSize('bounded')}>
                Bounded dimensions
              </Button>
            </div>
          ) : null}
          <p>
            Long content wraps inside the actual floating panel and scrolls when the panel is
            bounded.
          </p>
          <p>Second content block.</p>
          <p>Third content block.</p>
          <Popover.Close render={<Button size="small" />}>Close sized panel</Popover.Close>
        </Popover.Content>
      </Popover.Root>
    </div>
  );
}

function Contained() {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <div
      ref={setHost}
      data-dimensions-host
      {...stylex.props(styles.host)}
      style={{ '--spacing': '3px' } as CSSProperties}
    >
      <PopupContainerProvider container={host}>
        {host ? <DimensionsFixture /> : null}
      </PopupContainerProvider>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedPopoverDimensions',
  component: DimensionsFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof DimensionsFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Bounded: Story = {};
export const Zero: Story = { args: { initialSize: 'zero' } };
export const RootSpacing: Story = { args: { scoped: true } };
export const UpdateCycle: Story = { args: { update: true } };
export const ForcedDark: Story = {
  render: () => (
    <ThemeRoot mode="dark">
      <DimensionsFixture />
    </ThemeRoot>
  ),
};
export const NamedContainer: Story = { render: () => <Contained /> };
