import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import type { SessionPullRequestMetaWithLegacy } from '@lody/shared';
import { PullRequestBadge } from '@/components/sessions/pull-request-badge';
const badgePreview = stylex.create({
  root: {
    fontSize: 'var(--text-base)',
    lineHeight: 'var(--text-base--line-height)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2)',
  },
  icon: { height: 'calc(var(--spacing) * 12)', width: 'calc(var(--spacing) * 12)' },
});
const storyLayoutStyles = stylex.create({
  caption: {
    marginBottom: 'calc(var(--spacing) * 3)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-semibold)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  label: {
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  grid: {
    display: 'grid',
    gap: 'calc(var(--spacing) * 6)',
    color: 'hsl(var(--foreground) / 1)',
  },
  row: {
    display: 'flex',
    'flex-wrap': 'wrap',
    gap: 'calc(var(--spacing) * 3)',
  },
  stack: {
    display: 'flex',
    'flex-direction': 'column',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  label: {
    'font-size': '10px',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  row2: {
    display: 'flex',
    'flex-wrap': 'wrap',
    gap: 'calc(var(--spacing) * 6)',
  },
});

const basePr: SessionPullRequestMetaWithLegacy = {
  url: '#',
  number: 42,
  status: 'open',
  branch: 'feat/cool-feature',
  reportedAt: new Date().toISOString(),
};

const variants: Array<{ label: string; pr: SessionPullRequestMetaWithLegacy }> = [
  { label: 'Open', pr: { ...basePr } },
  { label: 'Draft', pr: { ...basePr, status: 'draft' } },
  { label: 'Closed', pr: { ...basePr, status: 'closed' } },
  { label: 'Merged', pr: { ...basePr, status: 'merged' } },
];

function AllVariants() {
  return (
    <div {...stylex.props(storyLayout.grid)}>
      {/* Normal size */}
      <div>
        <h3 {...stylex.props(storyLayoutStyles.caption)}>Normal (md)</h3>
        <div {...stylex.props(storyLayout.row)}>
          {variants.map(({ label, pr }) => (
            <div key={label} {...stylex.props(storyLayout.stack)}>
              <PullRequestBadge pr={pr} />
              <span {...stylex.props(storyLayout.label)}>{label}</span>
            </div>
          ))}
        </div>
      </div>
      {/* Large preview — icon scaled up to see detail */}
      <div>
        <h3 {...stylex.props(storyLayoutStyles.caption)}>Zoomed (48px icons)</h3>
        <div {...stylex.props(storyLayout.row2)}>
          {variants.map(({ label, pr }) => (
            <div key={`lg-${label}`} {...stylex.props(storyLayout.stack)}>
              <PullRequestBadge
                pr={pr}
                size="md"
                xstyle={badgePreview.root}
                iconXstyle={badgePreview.icon}
              />
              <span {...stylex.props(storyLayoutStyles.label)}>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'Sessions/PullRequestBadge',
  component: PullRequestBadge,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof PullRequestBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllStates: Story = {
  args: { pr: basePr },
  render: () => <AllVariants />,
};
