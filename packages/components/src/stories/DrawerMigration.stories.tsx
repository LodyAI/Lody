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

// Isolated acceptance controls for the existing legacy description contract.
function DescriptionOwnershipFixture({ mode }: { mode: 'default' | 'style' | 'child' | 'hidden' }) {
  return (
    <div {...stylex.props(styles.canvas)}>
      <Drawer open repositionInputs={false}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Legacy description contract</DrawerTitle>
            <DrawerDescription
              data-description-contract={mode}
              visuallyHidden={mode === 'hidden'}
              asChild={mode === 'child'}
              style={mode === 'style' ? { fontSize: '19px', lineHeight: '1.75' } : undefined}
            >
              {mode === 'child' ? (
                <p style={{ fontSize: '21px' }} data-description-slot-child="">
                  The slotted child keeps its own size.
                </p>
              ) : (
                'The original description keeps its accessible relationship and line height.'
              )}
            </DrawerDescription>
          </DrawerHeader>
          <div {...stylex.props(styles.body)}>
            <input aria-label="Description control draft" />
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}
export const DescriptionDefault: Story = {
  render: () => <DescriptionOwnershipFixture mode="default" />,
};
export const DescriptionCallerStyle: Story = {
  render: () => <DescriptionOwnershipFixture mode="style" />,
};
export const DescriptionAsChild: Story = {
  render: () => <DescriptionOwnershipFixture mode="child" />,
};
export const DescriptionHidden: Story = {
  render: () => <DescriptionOwnershipFixture mode="hidden" />,
};

function DescriptionFontSizeApiFixture() {
  const [size, setSize] = useState<React.CSSProperties['fontSize']>('0.78rem');
  const [caller, setCaller] = useState(false);
  return (
    <div {...stylex.props(styles.canvas)}>
      <Drawer open repositionInputs={false}>
        <DrawerContent style={{ fontSize: '23px' }}>
          <DrawerHeader>
            <DrawerTitle>Explicit description size</DrawerTitle>
            <DrawerDescription
              fontSize={size}
              style={
                {
                  '--legacy-description-size': '18px',
                  ...(caller ? { fontSize: '19px' } : {}),
                } as React.CSSProperties
              }
            >
              The physical size follows the selected value while caller styles retain priority.
            </DrawerDescription>
          </DrawerHeader>
          <div {...stylex.props(styles.body)}>
            {(['0.78rem', 'initial', 'inherit', 'var(--legacy-description-size)', 0] as const).map(
              (value) => (
                <button
                  type="button"
                  key={String(value)}
                  onClick={() => {
                    setCaller(false);
                    setSize(value);
                  }}
                >
                  {String(value)}
                </button>
              )
            )}
            <button
              type="button"
              onClick={() => {
                setSize('0.78rem');
                setCaller(true);
              }}
            >
              Caller style
            </button>
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}
export const DescriptionFontSizeApi: Story = { render: () => <DescriptionFontSizeApiFixture /> };
