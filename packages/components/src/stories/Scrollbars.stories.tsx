import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { ScrollArea } from '@lody/ui/scroll-area';

const styles = stylex.create({
  page: { padding: space[6], maxWidth: '960px', marginInline: 'auto' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: space[6] },
  section: { minWidth: 0 },
  heading: { margin: 0, marginBottom: space[3], fontSize: text.bodySize, fontWeight: 600 },
  frame: { height: '224px', backgroundColor: colors.secondaryBackground, borderRadius: space[2] },
  native: { overflowY: 'auto' },
  row: { padding: space[3], color: colors.label, fontSize: text.bodySize },
  textarea: { width: '100%', height: '224px' },
  horizontal: { height: '80px', overflowX: 'auto', overflowY: 'hidden' },
  wideRow: {
    display: 'flex',
    width: '1200px',
    gap: space[4],
    padding: space[4],
    whiteSpace: 'nowrap',
  },
  hidden: { scrollbarWidth: 'none', '::-webkit-scrollbar': { display: 'none' } },
});

const entries = Array.from(
  { length: 24 },
  (_, index) => `Workspace ${String(index + 1).padStart(2, '0')}`
);

function Rows() {
  return entries.map((entry) => (
    <div key={entry} {...stylex.props(styles.row)}>
      {entry}
    </div>
  ));
}

function ScrollbarsDemo() {
  return (
    <div {...stylex.props(styles.page)} data-testid="scrollbar-demo">
      <div {...stylex.props(styles.grid)}>
        <section {...stylex.props(styles.section)}>
          <h2 {...stylex.props(styles.heading)}>Native scroll container</h2>
          <div {...stylex.props(styles.frame, styles.native)} data-testid="native-scrollbar">
            <Rows />
          </div>
        </section>
        <section {...stylex.props(styles.section)}>
          <h2 {...stylex.props(styles.heading)}>ScrollArea</h2>
          <ScrollArea
            {...stylex.props(styles.frame)}
            visibility="always"
            data-testid="custom-scrollbar"
          >
            <Rows />
          </ScrollArea>
        </section>
        <section {...stylex.props(styles.section)}>
          <h2 {...stylex.props(styles.heading)}>Long menu</h2>
          <Menu.Root>
            <Menu.Trigger render={<Button />}>Choose workspace</Menu.Trigger>
            <Menu.Content>
              {entries.map((entry) => (
                <Menu.Item key={entry}>{entry}</Menu.Item>
              ))}
            </Menu.Content>
          </Menu.Root>
        </section>
        <section {...stylex.props(styles.section)}>
          <h2 {...stylex.props(styles.heading)}>Textarea</h2>
          <Textarea
            aria-label="Example workspace notes"
            className={stylex.props(styles.textarea).className}
            defaultValue={entries.join('\n')}
          />
        </section>
        <section {...stylex.props(styles.section)}>
          <h2 {...stylex.props(styles.heading)}>Horizontal overflow</h2>
          <div
            {...stylex.props(styles.frame, styles.horizontal)}
            data-testid="horizontal-scrollbar"
          >
            <div {...stylex.props(styles.wideRow)}>{entries.join(' · ')}</div>
          </div>
        </section>
        <section {...stylex.props(styles.section)}>
          <h2 {...stylex.props(styles.heading)}>Explicitly hidden scrollbar</h2>
          <div
            {...stylex.props(styles.frame, styles.native, styles.hidden)}
            data-testid="hidden-scrollbar"
          >
            <Rows />
          </div>
        </section>
      </div>
    </div>
  );
}

const meta = {
  title: 'Design System/Scrollbars',
  component: ScrollbarsDemo,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ScrollbarsDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
