import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ContextMenu } from '@lody/ui/context-menu';
import { Button } from '@lody/ui/button';
import { ThemeRoot } from '@lody/ui/theme';

const styles = stylex.create({ frame: { padding: 24, minHeight: 420 } });
type Bounds = 'bounded' | 'zero' | 'default';
const dimensions = {
  bounded: { minWidth: 180, maxWidth: 280, maxHeight: 'calc(var(--spacing) * 32)' },
  zero: { minWidth: 0, maxWidth: 0, maxHeight: 0 },
  default: {},
};

function ContextFixture({
  initial = 'bounded',
  scoped = false,
}: {
  initial?: Bounds;
  scoped?: boolean;
}) {
  const [bounds, setBounds] = useState(initial);
  const [checked, setChecked] = useState(false);
  const [positioner, setPositioner] = useState<HTMLDivElement | null>(null);
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
      data-context-dimensions
      data-bounds={bounds}
      data-checked={checked}
      data-scoped={scoped}
      {...stylex.props(styles.frame)}
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger render={<Button />}>Context target</ContextMenu.Trigger>
        <ContextMenu.Content
          ref={setPositioner}
          {...dimensions[bounds]}
          data-context-positioner
          style={{ minWidth: 93 }}
        >
          <ContextMenu.Item closeOnClick={false} onClick={() => setBounds('default')}>
            Default bounds
          </ContextMenu.Item>
          <ContextMenu.Item closeOnClick={false} onClick={() => setBounds('bounded')}>
            Bounded again
          </ContextMenu.Item>
          <ContextMenu.CheckboxItem
            checked={checked}
            onCheckedChange={setChecked}
            closeOnClick={false}
          >
            Retain selection
          </ContextMenu.CheckboxItem>
          <ContextMenu.Item disabled>Unavailable action</ContextMenu.Item>
          <ContextMenu.Item>Close menu</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Root>
      <output>{positioner != null ? 'Positioner attached' : 'Context menu closed'}</output>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedContextMenuDimensions',
  component: ContextFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ContextFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Bounded: Story = {};
export const Zero: Story = { args: { initial: 'zero' } };
export const RootSpacing: Story = { args: { scoped: true } };
export const UpdateCycle: Story = {};
export const ForcedDark: Story = {
  render: () => (
    <ThemeRoot mode="dark">
      <ContextFixture />
    </ThemeRoot>
  ),
};
