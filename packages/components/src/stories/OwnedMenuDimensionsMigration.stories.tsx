import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { ThemeRoot } from '@lody/ui/theme';
import { PopupContainerProvider } from '@lody/ui/popup-container';

const styles = stylex.create({
  frame: { padding: 16, minHeight: 450 },
  host: { position: 'relative', transform: 'translateX(4px)' },
});
type Dimensions = 'bounded' | 'zero' | 'default';
const bounds = {
  bounded: { minWidth: 190, maxWidth: 280, maxHeight: 'calc(var(--spacing) * 32)' },
  zero: { minWidth: 0, maxWidth: 0, maxHeight: 0 },
  default: {},
};

function MenuFixture({
  initial = 'bounded',
  compact = false,
}: {
  initial?: Dimensions;
  compact?: boolean;
}) {
  const [dimensions, setDimensions] = useState(initial);
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState('none');
  const [positioner, setPositioner] = useState<HTMLDivElement | null>(null);
  return (
    <div
      data-menu-dimensions
      data-dimensions={dimensions}
      data-selected={selected}
      {...stylex.props(styles.frame)}
    >
      <Menu.Root open={open} onOpenChange={setOpen}>
        <Menu.Trigger render={<Button />}>Open sized menu</Menu.Trigger>
        <Menu.Content
          ref={setPositioner}
          align="start"
          width={compact ? 'compact' : 'regular'}
          {...bounds[dimensions]}
          data-menu-positioner
          style={{ minWidth: 97 }}
        >
          <Menu.Item closeOnClick={false} onClick={() => setDimensions('default')}>
            Default dimensions
          </Menu.Item>
          <Menu.Item closeOnClick={false} onClick={() => setDimensions('bounded')}>
            Bounded dimensions
          </Menu.Item>
          <Menu.Item disabled>Unavailable command</Menu.Item>
          <Menu.CheckboxItem
            checked={selected === 'checked'}
            onCheckedChange={(checked) => setSelected(checked ? 'checked' : 'none')}
            closeOnClick={false}
          >
            Remember selection
          </Menu.CheckboxItem>
          <Menu.Item onClick={() => setSelected('applied')}>Apply command</Menu.Item>
        </Menu.Content>
      </Menu.Root>
      <output data-positioner-ready>{positioner != null ? 'positioner' : 'pending'}</output>
    </div>
  );
}

function Contained() {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setHost} data-menu-container {...stylex.props(styles.host)}>
      <PopupContainerProvider container={host}>
        {host ? <MenuFixture /> : null}
      </PopupContainerProvider>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedMenuDimensions',
  component: MenuFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof MenuFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Bounded: Story = {};
export const Zero: Story = { args: { initial: 'zero' } };
export const Compact: Story = { args: { compact: true } };
export const UpdateCycle: Story = {};
export const ForcedDark: Story = {
  render: () => (
    <ThemeRoot mode="dark">
      <MenuFixture />
    </ThemeRoot>
  ),
};
export const NamedContainer: Story = { render: () => <Contained /> };
