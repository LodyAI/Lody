import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ConversationOutlineRail } from '../components/ai-gui/conversation-outline-rail';
import type { ConversationOutlineEntry } from '../lib/conversation-outline';

const meta = {
  title: 'Sessions/OwnedOutlineRailMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const entries: ConversationOutlineEntry[] = Array.from({ length: 100 }, (_, index) => ({
  key: `synthetic-outline-${index}`,
  messageIndex: index * 2,
  title:
    index === 2
      ? ''
      : index === 1
        ? 'Synthetic long title · 长路径与多语言换行 · packages/synthetic-workspace/outline/reader-position.tsx '.repeat(
            4
          )
        : `Synthetic turn ${index + 1}`,
  preview:
    index === 2
      ? ''
      : 'Synthetic reply explaining an investigation and its result. 这里是合成内容，不访问后端。 '.repeat(
          5
        ),
  startsWithAgent: index === 2,
  weight: (index % 4) as ConversationOutlineEntry['weight'],
}));

function Fixture({
  mode = 'basic',
}: {
  mode?: 'basic' | 'overflow' | 'subtree' | 'flex-last' | 'hidden-last' | 'portal';
}) {
  const [activeIndex, setActiveIndex] = useState(mode === 'overflow' ? 70 : 0);
  const [lastJump, setLastJump] = useState(-1);
  const [lastPreview, setLastPreview] = useState(-1);
  const [overlayRoot, setOverlayRoot] = useState<HTMLDivElement | null>(null);
  const scopedVariables =
    mode === 'subtree'
      ? ({ '--muted-foreground': '320 80% 40%', '--foreground': '150 75% 30%' } as CSSProperties)
      : undefined;
  const callerClassName =
    mode === 'flex-last'
      ? 'hidden flex [&_button>span]:bg-[#8053b8]'
      : mode === 'hidden-last'
        ? 'flex hidden [&_button>span]:bg-[#8053b8]'
        : undefined;
  return (
    <main
      {...stylex.props(stylex.defaultMarker())}
      data-outline-fixture={mode}
      data-last-jump={lastJump}
      data-last-preview={lastPreview}
      tabIndex={0}
      aria-label="Synthetic unrelated outer marker"
      style={{
        ...scopedVariables,
        width: '100%',
        minHeight: 600,
        color: 'hsl(var(--foreground))',
        background: 'hsl(var(--background))',
      }}
    >
      <header style={{ padding: 16, minHeight: 72 }}>
        <strong>Production conversation outline · synthetic entries</strong>
        <div data-outline-events>
          Jump: {lastJump}; preview: {lastPreview}
        </div>
      </header>
      <section
        data-outline-container
        style={{ containerType: 'inline-size', position: 'relative', height: 440 }}
      >
        {mode === 'portal' ? (
          <div
            ref={setOverlayRoot}
            data-outline-portal-root
            style={{
              containerType: 'inline-size',
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
            }}
          />
        ) : null}
        <div style={{ marginInline: 'auto', width: '70%', maxWidth: 700, paddingBlock: 40 }}>
          <p>Synthetic conversation backdrop; the real production rail sits in the left margin.</p>
          <p>Current turn: {activeIndex + 1}. Keyboard and pointer jumps update this fixture.</p>
        </div>
        <ConversationOutlineRail
          entries={mode === 'overflow' ? entries : entries.slice(0, 6)}
          activeIndex={activeIndex}
          onJumpToRound={(index) => {
            setActiveIndex(index);
            setLastJump(index);
          }}
          onPreviewRound={setLastPreview}
          overlayRoot={mode === 'portal' ? overlayRoot : undefined}
          className={callerClassName}
        />
      </section>
      <footer style={{ padding: 16 }}>Outer marker area outside the rail.</footer>
    </main>
  );
}

export const Basic: Story = { render: () => <Fixture /> };
export const Overflow: Story = { render: () => <Fixture mode="overflow" /> };
export const SubtreeVariables: Story = { render: () => <Fixture mode="subtree" /> };
export const CallerFlexLast: Story = { render: () => <Fixture mode="flex-last" /> };
export const CallerHiddenLast: Story = { render: () => <Fixture mode="hidden-last" /> };
export const Portalled: Story = { render: () => <Fixture mode="portal" /> };
