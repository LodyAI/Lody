import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { Pin } from 'lucide-react';

import {
  MobileSwipeableRow,
  MobileSwipeableRowGroup,
} from '@/components/mobile/mobile-swipeable-row';

type Row = { id: string; title: string; subtitle: string; pinned?: boolean };

const storyStyles = stylex.create({
  canvas: {
    display: 'flex',
    minHeight: '100dvh',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'var(--color-stone-200, oklch(92.3% 0.003 48.717))',
    padding: { default: 0, '@media (min-width: 40rem)': 'calc(var(--spacing) * 6)' },
  },
  frame: {
    height: { default: '100dvh', '@media (min-width: 40rem)': '852px' },
    width: { default: '100%', '@media (min-width: 40rem)': '393px' },
    borderRadius: { default: null, '@media (min-width: 40rem)': '34px' },
    backgroundColor: 'hsl(var(--background) / 1)',
    boxShadow: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
    overflowY: 'auto',
    paddingBottom: 'calc(var(--spacing) * 12)',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 3)',
    backgroundColor: 'hsl(var(--card) / 1)',
    paddingInline: 'calc(var(--spacing) * 4)',
    paddingBlock: 'calc(var(--spacing) * 3)',
  },
  avatar: {
    height: 'calc(var(--spacing) * 9)',
    width: 'calc(var(--spacing) * 9)',
    flexShrink: 0,
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'hsl(var(--muted) / 1)',
  },
  content: { minWidth: 0, flex: '1' },
  titleRow: { display: 'flex', alignItems: 'center', gap: 'calc(var(--spacing) * 1)' },
  pin: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
    flexShrink: 0,
    color: 'hsl(var(--primary))',
  },
  title: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
  },
  dimmed: { color: 'hsl(var(--muted-foreground) / 1)' },
  caption: {
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  list: {
    overflow: 'hidden',
    borderRadius: 'var(--radius-2xl)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab,hsl(var(--border) / 1) 40%,transparent)',
    backgroundColor: 'hsl(var(--card) / 1)',
  },
  divider: {
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderColor: 'color-mix(in oklab,hsl(var(--border) / 1) 40%,transparent)',
  },
  heading: {
    paddingInline: 'calc(var(--spacing) * 5)',
    paddingBottom: 'calc(var(--spacing) * 1)',
    paddingTop: 'calc(var(--spacing) * 6)',
    fontSize: 'var(--text-xl)',
    lineHeight: 'var(--text-xl--line-height)',
    fontWeight: 'var(--font-weight-semibold)',
  },
  hint: { paddingInline: 'calc(var(--spacing) * 5)', paddingBottom: 'calc(var(--spacing) * 3)' },
  listInset: { paddingInline: 'calc(var(--spacing) * 3)' },
});
const initialRows: Row[] = [
  { id: '1', title: '重构评估 UI', subtitle: 'feat/eval-ui · 30m', pinned: true },
  { id: '2', title: '同步进度提示', subtitle: 'feat/sync-progress · 5h' },
  { id: '3', title: '权限审批弹窗', subtitle: 'fix/permission-modal · 1d' },
  { id: '4', title: '登录页 OAuth', subtitle: 'fix/oauth · 2d' },
  { id: '5', title: '移动端归档体验', subtitle: 'feat/mobile-archive · 3d' },
];

function RowContent({ row, dimmed }: { row: Row; dimmed?: boolean }) {
  return (
    <div {...stylex.props(storyStyles.row)}>
      <div {...stylex.props(storyStyles.avatar)} />
      <div {...stylex.props(storyStyles.content)}>
        <div {...stylex.props(storyStyles.titleRow)}>
          {row.pinned ? (
            <Pin {...stylex.props(storyStyles.pin)} />
          ) : null}
          <span {...stylex.props(storyStyles.title, dimmed && storyStyles.dimmed)}
          >
            {row.title}
          </span>
        </div>
        <div {...stylex.props(storyStyles.caption, storyStyles.truncate)}>{row.subtitle}</div>
      </div>
      <span {...stylex.props(storyStyles.caption)}>›</span>
    </div>
  );
}

function StoryShell({
  grouped,
  variant = 'active',
}: {
  grouped: boolean;
  variant?: 'active' | 'archived';
}) {
  const [rows, setRows] = useState(initialRows);
  const archived = variant === 'archived';

  const togglePin = (id: string) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, pinned: !r.pinned } : r)));
  };
  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
    fn()(id);
  };

  const list = (
    <div {...stylex.props(storyStyles.list)}>
      {rows.map((row, i) => (
        <div key={row.id} {...stylex.props(i > 0 && storyStyles.divider)}>
          {archived ? (
            <MobileSwipeableRow
              variant="archived"
              onRestore={() => removeRow(row.id)}
              onDelete={() => removeRow(row.id)}
              restoreAriaLabel="恢复"
              deleteAriaLabel="删除"
            >
              <RowContent row={row} dimmed />
            </MobileSwipeableRow>
          ) : (
            <MobileSwipeableRow
              isPinned={row.pinned}
              onTogglePin={() => togglePin(row.id)}
              onArchive={() => removeRow(row.id)}
              pinAriaLabel="Pin"
              unpinAriaLabel="Unpin"
              archiveAriaLabel="Archive"
            >
              <RowContent row={row} />
            </MobileSwipeableRow>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div {...stylex.props(storyStyles.canvas)}>
      <div {...stylex.props(storyStyles.frame)}>
        <div {...stylex.props(storyStyles.heading)}>
          {archived ? '归档对话 — 左滑恢复 / 删除' : 'Swipe a row left'}
        </div>
        <p {...stylex.props(storyStyles.caption, storyStyles.hint)}>
          {archived
            ? '归档列表：左滑漏出「恢复」和「删除」,没有 super-swipe(删除不可逆,需走确认)。'
            : grouped
              ? '所有 row 共享 group — 滑开一行,其它会自动收回(iOS Mail 行为)。'
              : '没有 group — 每一行独立,可以同时打开多行 drawer。'}
        </p>
        <div {...stylex.props(storyStyles.listInset)}>
          {grouped ? <MobileSwipeableRowGroup>{list}</MobileSwipeableRowGroup> : list}
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileSwipeableRow',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Grouped: Story = {
  args: { grouped: true },
};

export const Standalone: Story = {
  args: { grouped: false },
};

export const Archived: Story = {
  args: { grouped: true, variant: 'archived' },
};
