import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Archive, RotateCcw, Trash2 } from 'lucide-react';
import { SwipeActionRow } from '../components/shared/swipe-action-row';
import { themeColors } from '../style/theme-colors.stylex';
import { themeFontSize, themeRadius, themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    minHeight: '100vh',
    padding: themeSpace[4],
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  column: {
    width: 480,
    maxWidth: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[3],
  },
  row: {
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: themeColors.border,
    borderRadius: themeRadius.md,
  },
  face: {
    display: 'flex',
    minHeight: 72,
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[3],
    padding: themeSpace[3],
    textAlign: 'left',
  },
  text: { minWidth: 0, flex: '1 1 0%' },
  title: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  hint: { display: 'block', fontSize: themeFontSize.xs, color: themeColors.mutedForeground },
  archive: { backgroundColor: themeColors.statusWarning, color: themeColors.background },
  restore: { backgroundColor: themeColors.statusSuccess, color: themeColors.background },
  remove: { backgroundColor: themeColors.destructive, color: themeColors.primaryForeground },
  glyph: { width: 18, height: 18 },
  output: { minHeight: 24, fontSize: themeFontSize.sm, overflowWrap: 'anywhere' },
});

const meta = {
  title: 'Shared/SwipeActionMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Fixture({
  multiple = false,
  long = false,
  commit = false,
  disabled = false,
  empty = false,
  independent = false,
}) {
  const [events, setEvents] = useState<string[]>([]);
  const record = (event: string) => setEvents((current) => [...current, event]);
  const rows = independent ? ['primary', 'secondary'] : ['primary'];
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.column)}>
        {rows.map((id) => (
          <div key={id} data-swipe-fixture={id}>
            <SwipeActionRow
              enabled={!disabled}
              actions={
                empty
                  ? []
                  : multiple
                    ? [
                        {
                          key: 'restore',
                          label: 'Restore',
                          className: stylex.props(styles.restore).className,
                          icon: <RotateCcw {...stylex.props(styles.glyph)} />,
                          onClick: () => record(`${id}:restore`),
                        },
                        {
                          key: 'delete',
                          label: 'Delete',
                          className: stylex.props(styles.remove).className,
                          icon: <Trash2 {...stylex.props(styles.glyph)} />,
                          onClick: () => record(`${id}:delete`),
                        },
                      ]
                    : [
                        {
                          key: 'archive',
                          label: long ? '归档此会话 Archive this conversation' : 'Archive',
                          ariaLabel: 'Archive conversation',
                          className: stylex.props(styles.archive).className,
                          icon: <Archive {...stylex.props(styles.glyph)} />,
                          onClick: () => record(`${id}:archive`),
                        },
                      ]
              }
              onCommit={commit ? () => record(`${id}:commit`) : undefined}
              className={stylex.props(styles.row).className}
            >
              <button
                type="button"
                data-swipe-face={id}
                {...stylex.props(styles.face)}
                onClick={() => record(`${id}:open`)}
              >
                <Archive {...stylex.props(styles.glyph)} />
                <span {...stylex.props(styles.text)}>
                  <span {...stylex.props(styles.title)}>
                    {long
                      ? '一个很长的会话标题 — review the responsive layout and preserve the original gesture behavior'
                      : `${id === 'primary' ? 'Review migration' : 'Second conversation'}`}
                  </span>
                  <span {...stylex.props(styles.hint)}>
                    Synthetic local conversation · touch swipe actions
                  </span>
                </span>
              </button>
            </SwipeActionRow>
          </div>
        ))}
        <button
          type="button"
          data-swipe-outside
          onClick={() => record('outside')}
          {...stylex.props(styles.face)}
        >
          Outside row
        </button>
        <output data-swipe-events {...stylex.props(styles.output)}>
          {events.length ? events.join(' · ') : 'No action performed'}
        </output>
      </div>
    </div>
  );
}

export const SingleArchive: Story = { render: () => <Fixture /> };
export const MultipleActions: Story = { render: () => <Fixture multiple /> };
export const LongLabels: Story = { render: () => <Fixture long /> };
export const Commit: Story = { render: () => <Fixture commit /> };
export const Disabled: Story = { render: () => <Fixture disabled /> };
export const EmptyActions: Story = { render: () => <Fixture empty /> };
export const IndependentRows: Story = { render: () => <Fixture independent /> };
