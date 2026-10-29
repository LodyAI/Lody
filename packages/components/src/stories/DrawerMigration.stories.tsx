import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import {
  Drawer,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
} from '@/ui/drawer';
import { MobileWorktreeConfigSheet } from '@/components/mobile/mobile-worktree-config-sheet';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    minHeight: '100dvh',
    padding: themeSpace[4],
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  body: { paddingInline: themeSpace[4], overflowY: 'auto', minHeight: 0 },
  row: { paddingBlock: themeSpace[3], borderBottom: '1px solid hsl(var(--border))' },
  field: {
    display: 'block',
    marginTop: themeSpace[3],
    padding: themeSpace[2],
    width: '100%',
    backgroundColor: themeColors.inputField,
    border: '1px solid hsl(var(--input-border))',
  },
  output: { display: 'block', marginTop: themeSpace[3] },
});

function DrawerFixture({
  direction = 'bottom',
  long = false,
  caller = false,
  fullscreen = false,
  inlineHeight = false,
}: {
  direction?: 'bottom' | 'top' | 'left' | 'right';
  long?: boolean;
  caller?: boolean;
  fullscreen?: boolean;
  inlineHeight?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div {...stylex.props(styles.canvas)}>
      <Drawer direction={direction} open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>
          <Button>Open drawer</Button>
        </DrawerTrigger>
        <DrawerContent
          width={fullscreen ? 'full' : undefined}
          className={
            fullscreen
              ? 'inset-0 rounded-none border-0 border-l-0!'
              : caller
                ? 'h-auto! max-h-[88dvh]! rounded-t-2xl border-border/60'
                : undefined
          }
          style={
            inlineHeight
              ? { height: '92dvh', maxHeight: '92dvh' }
              : caller
                ? ({ paddingBottom: 7, '--lody-drawer-width': '292px' } as React.CSSProperties)
                : undefined
          }
        >
          <DrawerHeader
            className={caller ? 'gap-3 p-6 text-left' : undefined}
            style={caller ? { paddingBottom: 9 } : undefined}
          >
            <DrawerTitle className={caller ? 'font-medium' : undefined}>
              Drawer migration
            </DrawerTitle>
            <DrawerDescription>Inspect the original drawer layout and controls.</DrawerDescription>
          </DrawerHeader>
          <div data-testid="drawer-scroll-body" {...stylex.props(styles.body)}>
            {long ? (
              Array.from({ length: 24 }, (_, index) => (
                <div key={index} {...stylex.props(styles.row)}>
                  Drawer row {String(index + 1).padStart(2, '0')}
                </div>
              ))
            ) : (
              <p>Direction: {direction}. The sheet keeps its current geometry.</p>
            )}
            <label>
              Drawer input
              <input
                aria-label="Drawer input"
                placeholder="Type a note"
                {...stylex.props(styles.field)}
              />
            </label>
          </div>
          <DrawerFooter className={caller ? 'gap-3 p-6' : undefined}>
            <Button onClick={() => setOpen(false)}>Confirm drawer</Button>
            <DrawerClose asChild>
              <Button variant="secondary">Close drawer</Button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
      <output aria-label="Drawer status" {...stylex.props(styles.output)}>
        {open ? 'Drawer open' : 'Drawer closed'}
      </output>
    </div>
  );
}

function WorktreeConsumer() {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState('Not saved');
  return (
    <div {...stylex.props(styles.canvas)}>
      <Button onClick={() => setOpen(true)}>Open worktree configuration</Button>
      <output {...stylex.props(styles.output)}>{saved}</output>
      <MobileWorktreeConfigSheet
        open={open}
        onOpenChange={setOpen}
        shell="bash"
        setupConfig={{ scripts: { bash: 'pnpm install' } }}
        cleanupConfig={{ scripts: { bash: 'rm -rf .cache' } }}
        onSetupSave={() => setSaved('Setup saved')}
        onCleanupSave={() => setSaved('Cleanup saved')}
      />
    </div>
  );
}

const meta = { title: 'UI/DrawerMigration', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Bottom: Story = { render: () => <DrawerFixture /> };
export const Top: Story = { render: () => <DrawerFixture direction="top" /> };
export const Left: Story = { render: () => <DrawerFixture direction="left" /> };
export const Right: Story = { render: () => <DrawerFixture direction="right" /> };
export const LongContent: Story = { render: () => <DrawerFixture long /> };
export const CallerOverrides: Story = { render: () => <DrawerFixture caller /> };
export const WorktreeConfiguration: Story = { render: () => <WorktreeConsumer /> };

export const FullscreenLeft: Story = {
  render: () => <DrawerFixture direction="left" fullscreen />,
};
export const FullscreenRight: Story = {
  render: () => <DrawerFixture direction="right" fullscreen />,
};
export const InlineHeight: Story = { render: () => <DrawerFixture inlineHeight /> };
