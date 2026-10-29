import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { TerminalComponent } from '@/components/ai-gui/terminal-component';
import { ProposedPlanBlock } from '@/components/ai-gui/view';

const styles = stylex.create({
  canvas: { padding: 16 },
  panel: { width: '100%', maxWidth: 640 },
});
const scope = {
  '--spacing': '5px',
  '--foreground': '215 65% 35%',
  '--muted-foreground': '300 45% 42%',
  '--border': '155 70% 40%',
} as CSSProperties;

function TerminalFixture({ scoped = false }: { scoped?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div {...stylex.props(styles.canvas)}>
      <div
        {...stylex.props(styles.panel)}
        data-owned-panel="terminal"
        data-panel-scope={scoped ? 'local' : 'default'}
        style={scoped ? scope : undefined}
      >
        <TerminalComponent
          title="Inspect synthetic working directory with an intentionally long terminal header"
          command="printf 'synthetic preview'"
          output={'synthetic preview\nline two\nline three'}
          bodyVisible={expanded}
          headerExpanded={expanded}
          onHeaderClick={() => setExpanded((value) => !value)}
        />
      </div>
    </div>
  );
}

function ScopedPlanFixture() {
  return (
    <div {...stylex.props(styles.canvas)}>
      <div
        {...stylex.props(styles.panel)}
        data-owned-panel="plan"
        data-panel-scope="local"
        style={scope}
      >
        <ProposedPlanBlock
          plan={{
            type: 'proposed_plan',
            turnId: 'synthetic-panel-scope-turn',
            markdown:
              '# Synthetic plan\n\nVerify scoped layout and ink.\n\n' +
              Array.from({ length: 24 }, (_, index) => `- Synthetic step ${index + 1}`).join('\n'),
            status: 'completed',
            isLatest: true,
          }}
          messageId="synthetic-panel-scope-message"
          itemIndex={0}
        />
      </div>
    </div>
  );
}

const meta = {
  title: 'Migration/ConversationPanel',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const TerminalInteractive: Story = { render: () => <TerminalFixture /> };
export const TerminalInteractiveScoped: Story = { render: () => <TerminalFixture scoped /> };
export const PlanScoped: Story = { render: () => <ScopedPlanFixture /> };
