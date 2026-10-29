import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Popover } from '@lody/ui/popover';
import { Button } from '@lody/ui/button';
import { Field } from '@lody/ui/field';
import { Input } from '@lody/ui/input';
import { ThemeRoot } from '@lody/ui/theme';
import { PopupContainerProvider } from '@lody/ui/popup-container';
import { themeColors } from '../style/theme-colors.stylex';

const styles = stylex.create({
  frame: {
    padding: 24,
    minHeight: 440,
    color: themeColors.foreground,
    backgroundColor: themeColors.background,
  },
  row: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  body: { display: 'flex', flexDirection: 'column', gap: 8 },
  contained: { position: 'relative', transform: 'translateX(8px)', minHeight: 480 },
});

type Layout = 'default' | 'padding' | 'gap' | 'both';

function LayoutFixture({
  initialLayout = 'default',
  update = false,
  contained = false,
}: {
  initialLayout?: Layout;
  update?: boolean;
  contained?: boolean;
}) {
  const [layout, setLayout] = useState(initialLayout);
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState('Preserved input');
  const [applied, setApplied] = useState(0);
  const [event, setEvent] = useState('none');
  const [positioner, setPositioner] = useState<HTMLDivElement | null>(null);
  return (
    <div
      data-popover-layout-fixture
      data-layout={layout}
      data-layout-open={open}
      data-layout-value={value}
      data-layout-applied={applied}
      data-layout-event={event}
      data-layout-contained={contained}
      data-layout-ref-ready={Boolean(positioner?.querySelector('[role=dialog]'))}
      {...stylex.props(styles.frame)}
    >
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger render={<Button />}>Open layout panel</Popover.Trigger>
        <Popover.Content
          ref={setPositioner}
          align="start"
          side="bottom"
          data-layout-positioner
          style={{ minWidth: 240 }}
          padding={layout === 'padding' || layout === 'both' ? 'none' : 'default'}
          gap={layout === 'gap' || layout === 'both' ? 'none' : 'default'}
          onPointerEnter={(event) =>
            setEvent(
              event.currentTarget.hasAttribute('data-layout-positioner')
                ? 'positioner-enter'
                : 'other-enter'
            )
          }
        >
          <Popover.Header>
            <Popover.Title>Layout panel</Popover.Title>
            <Popover.Description>Padding and gap belong to this panel.</Popover.Description>
          </Popover.Header>
          <div {...stylex.props(styles.body)} data-layout-body>
            <Field.Root>
              <Field.Label>Preserved value</Field.Label>
              <Input
                aria-label="Preserved value"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </Field.Root>
            {update ? (
              <div {...stylex.props(styles.row)}>
                <Button size="small" onClick={() => setLayout('padding')}>
                  Zero padding
                </Button>
                <Button size="small" onClick={() => setLayout('gap')}>
                  Zero gap
                </Button>
                <Button size="small" onClick={() => setLayout('default')}>
                  Default layout
                </Button>
              </div>
            ) : null}
            <div {...stylex.props(styles.row)}>
              <Button size="small" onClick={() => setApplied((count) => count + 1)}>
                Apply value
              </Button>
              <Popover.Close render={<Button size="small" />}>Close panel</Popover.Close>
            </div>
            <output data-layout-result>
              Applied {applied}; {value}
            </output>
          </div>
        </Popover.Content>
      </Popover.Root>
    </div>
  );
}

function ContainedFixture() {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setHost} data-layout-container {...stylex.props(styles.contained)}>
      <PopupContainerProvider container={host}>
        {host ? <LayoutFixture initialLayout="both" contained /> : null}
      </PopupContainerProvider>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedPopoverLayout',
  component: LayoutFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof LayoutFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultPanel: Story = {};
export const ZeroPadding: Story = { args: { initialLayout: 'padding' } };
export const ZeroGap: Story = { args: { initialLayout: 'gap' } };
export const ZeroBoth: Story = { args: { initialLayout: 'both' } };
export const UpdateCycle: Story = { args: { initialLayout: 'both', update: true } };
export const ForcedDark: Story = {
  render: () => (
    <ThemeRoot mode="dark">
      <LayoutFixture initialLayout="both" />
    </ThemeRoot>
  ),
};
export const Contained: Story = { render: () => <ContainedFixture /> };
