import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable';
import {
  CollapsibleCard,
  CollapsibleCardContent,
  CollapsibleCardHeader,
  CollapsibleCardTitle,
} from '../ui/collapsible-card';
import { SessionFileDiffNoticeCard } from '../components/sessions/session-file-diff-notice-card';
import { DiffViewer } from '../ui/diff-viewer/diff-viewer';
import { themeColors } from '../style/theme-colors.stylex';
import { themeFontSize, themeLineHeight, themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    minHeight: '100vh',
    padding: themeSpace[4],
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  frame: { width: 760, maxWidth: '100%', height: 380, border: `1px solid ${themeColors.border}` },
  pane: { height: '100%', padding: themeSpace[4], backgroundColor: themeColors.card },
  alternate: { backgroundColor: themeColors.muted },
  label: { fontSize: themeFontSize.sm, lineHeight: themeLineHeight.sm },
  list: { display: 'flex', flexDirection: 'column', gap: themeSpace[4], maxWidth: 720 },
  body: { paddingInline: themeSpace[4] },
  line: { paddingBlock: themeSpace[2], borderBottom: `1px solid ${themeColors.border}` },
  outerScroll: { height: 280, overflow: 'auto', border: `1px solid ${themeColors.border}` },
  wide: { width: 960, padding: themeSpace[4] },
  stickyHeader: { paddingInline: themeSpace[4], backgroundColor: themeColors.card },
});

const meta = {
  title: 'UI/RoundLayoutMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Pane({ name, alternate = false }: { name: string; alternate?: boolean }) {
  return (
    <div {...stylex.props(styles.pane, alternate && styles.alternate)}>
      <p {...stylex.props(styles.label)}>{name}</p>
      <Button size="small">{name} action</Button>
    </div>
  );
}

function ResizeFixture({
  vertical = false,
  disabled = false,
  nested = false,
  consumer = false,
}: {
  vertical?: boolean;
  disabled?: boolean;
  nested?: boolean;
  consumer?: boolean;
}) {
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.frame)}>
        <ResizablePanelGroup direction={vertical ? 'vertical' : 'horizontal'} id="layout-outer">
          <ResizablePanel defaultSize={55} minSize={20} id="layout-first">
            <Pane name="First panel" />
          </ResizablePanel>
          <ResizableHandle
            id="layout-handle"
            aria-label="Resize main panels"
            withHandle={!consumer}
            disabled={disabled}
            hitAreaMargins={consumer ? { coarse: 15, fine: 12 } : undefined}
            className={
              consumer
                ? 'bg-transparent transition-opacity after:left-0 after:w-[2px] after:translate-x-0 after:inset-y-0 after:top-0 after:bottom-0 after:transition-colors after:duration-150 data-[resize-handle-state=hover]:after:bg-sidebar-ring/50 data-[resize-handle-state=hover]:after:delay-150 data-[resize-handle-state=drag]:after:bg-sidebar-ring/70'
                : undefined
            }
          />
          <ResizablePanel defaultSize={45} minSize={20} id="layout-second">
            {nested ? (
              <ResizablePanelGroup direction="vertical" id="layout-inner">
                <ResizablePanel defaultSize={50} minSize={25} id="layout-upper">
                  <Pane name="Upper panel" alternate />
                </ResizablePanel>
                <ResizableHandle
                  id="layout-inner-handle"
                  aria-label="Resize nested panels"
                  withHandle
                />
                <ResizablePanel defaultSize={50} minSize={25} id="layout-lower">
                  <Pane name="Lower panel" />
                </ResizablePanel>
              </ResizablePanelGroup>
            ) : (
              <Pane name="Second panel" alternate />
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

function Lines({ count = 22 }: { count?: number }) {
  return (
    <div {...stylex.props(styles.body)}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} {...stylex.props(styles.line)}>
          Synthetic row {String(index + 1).padStart(2, '0')} — layout and scrolling
        </div>
      ))}
    </div>
  );
}

function CardStatesFixture() {
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.list)}>
        <CollapsibleCard defaultOpen data-layout-card="open">
          <CollapsibleCardHeader data-layout-header="open">
            <CollapsibleCardTitle title="Synthetic long file title">
              Synthetic long file title — 中文路径 — a-very-long-file-name.tsx
            </CollapsibleCardTitle>
          </CollapsibleCardHeader>
          <CollapsibleCardContent data-layout-content="open">
            <Lines />
          </CollapsibleCardContent>
        </CollapsibleCard>
        <CollapsibleCard data-layout-card="closed">
          <CollapsibleCardHeader position="relative" data-layout-header="closed">
            <CollapsibleCardTitle>Initially closed</CollapsibleCardTitle>
          </CollapsibleCardHeader>
          <CollapsibleCardContent noInternalScroll data-layout-content="closed">
            <Lines count={3} />
          </CollapsibleCardContent>
        </CollapsibleCard>
        <CollapsibleCard defaultOpen disabled data-layout-card="disabled">
          <CollapsibleCardHeader position="relative" data-layout-header="disabled">
            <CollapsibleCardTitle>Disabled open card</CollapsibleCardTitle>
          </CollapsibleCardHeader>
          <CollapsibleCardContent noInternalScroll>
            <Lines count={2} />
          </CollapsibleCardContent>
        </CollapsibleCard>
      </div>
    </div>
  );
}

function StickyFixture() {
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.list)}>
        <div {...stylex.props(styles.outerScroll)} data-layout-outer-scroll>
          <CollapsibleCard defaultOpen allowStickyChildren data-layout-card="sticky">
            <CollapsibleCardHeader
              sticky
              data-layout-header="sticky"
              className={stylex.props(styles.stickyHeader).className}
            >
              <CollapsibleCardTitle>Sticky header in external scroll</CollapsibleCardTitle>
            </CollapsibleCardHeader>
            <CollapsibleCardContent
              noInternalScroll
              showTopFade={false}
              data-layout-content="sticky"
            >
              <Lines count={30} />
            </CollapsibleCardContent>
          </CollapsibleCard>
        </div>
        <CollapsibleCard defaultOpen data-layout-card="wide">
          <CollapsibleCardHeader position="relative" data-layout-header="wide">
            <CollapsibleCardTitle>Horizontal content scroll</CollapsibleCardTitle>
          </CollapsibleCardHeader>
          <CollapsibleCardContent noInternalScroll data-layout-content="wide">
            <div {...stylex.props(styles.wide)}>
              Wide synthetic content keeps the original horizontal scroll contract.
            </div>
          </CollapsibleCardContent>
        </CollapsibleCard>
      </div>
    </div>
  );
}

function ConsumersFixture() {
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.list)}>
        <SessionFileDiffNoticeCard
          filePath="src/synthetic/very-long-file-name.tsx"
          message="Synthetic file notice preserves caller surface, border, header height and zero bottom padding."
        />
        <DiffViewer
          path="src/synthetic/example.ts"
          oldText={'export const value = 1;\n'}
          newText={'export const value = 2;\nexport const ready = true;\n'}
          defaultOpen
        />
      </div>
    </div>
  );
}

export const Horizontal: Story = { render: () => <ResizeFixture /> };
export const Vertical: Story = { render: () => <ResizeFixture vertical /> };
export const Nested: Story = { render: () => <ResizeFixture nested /> };
export const Disabled: Story = { render: () => <ResizeFixture disabled /> };
export const ConsumerHandle: Story = { render: () => <ResizeFixture consumer /> };
export const CardStates: Story = { render: () => <CardStatesFixture /> };
export const CardSticky: Story = { render: () => <StickyFixture /> };
export const CardConsumers: Story = { render: () => <ConsumersFixture /> };
