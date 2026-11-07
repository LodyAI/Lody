import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { withClassName } from '@/lib/stylex';
import {
  MobileFilterPillBar,
  type FilterPill,
  type MultiSelectPill,
} from '@/components/mobile/mobile-filter-pill-bar';
import { themeColors } from '../style/theme-colors.stylex';

const styles = stylex.create({
  frame: { maxWidth: 680, paddingBlock: 16, backgroundColor: themeColors.background },
  controls: { display: 'flex', alignItems: 'center', gap: 8, paddingInline: 12 },
  result: { display: 'block', padding: 12, fontSize: 12, color: themeColors.mutedForeground },
  scope: { marginBlock: 8, borderWidth: 1, borderStyle: 'solid', borderColor: themeColors.border },
  scopeLabel: { display: 'block', paddingInline: 12, paddingTop: 8, fontSize: 12 },
});

function FilterFixture({
  aggregate = false,
  engaged = false,
}: {
  aggregate?: boolean;
  engaged?: boolean;
}) {
  const [scope, setScope] = useState('all');
  const [machines, setMachines] = useState(new Set(engaged ? ['alpha'] : ['alpha', 'beta']));
  const [lastAction, setLastAction] = useState('Ready');
  const machinePill: MultiSelectPill = {
    kind: 'multi',
    id: 'machines',
    label: 'Machines',
    options: [
      { id: 'alpha', label: 'Alpha' },
      { id: 'beta', label: 'Beta' },
    ],
    selectedIds: machines,
    defaultIds: new Set(['alpha', 'beta']),
    onChange: (next) => {
      setMachines(next);
      setLastAction(`Machines ${[...next].sort().join(',')}`);
    },
  };
  const pills: FilterPill[] = aggregate
    ? [{ kind: 'aggregate', id: 'filters', label: 'Filter options', pills: [machinePill] }]
    : [
        {
          kind: 'single',
          id: 'scope',
          fallbackLabel: 'Scope',
          options: [
            { id: 'all', label: 'All conversations' },
            { id: 'team', label: 'Team conversations' },
          ],
          selectedId: scope,
          onSelect: (next) => {
            setScope(next);
            setLastAction(`Scope ${next}`);
          },
        },
        machinePill,
      ];
  return (
    <div data-owned-filter-fixture data-owned-filter-action={lastAction}>
      <MobileFilterPillBar pills={pills} />
      <output {...stylex.props(styles.result)}>{lastAction}</output>
    </div>
  );
}

function ScopeFixture() {
  const [scope, setScope] = useState('dark-scope');
  return (
    <div {...stylex.props(styles.frame)} data-owned-filter-scopes>
      <div {...stylex.props(styles.controls)}>
        <Button
          size="small"
          onClick={() =>
            setScope((current) => (current === 'dark-scope' ? 'light-scope' : 'dark-scope'))
          }
        >
          Toggle local scope
        </Button>
        <output data-owned-filter-dynamic-scope={scope}>{scope}</output>
      </div>
      {[
        { id: 'dark', outer: 'dark', inner: '' },
        { id: 'dark-scope', outer: 'dark-scope', inner: '' },
        { id: 'light-exclusion', outer: 'dark-scope', inner: 'light-scope' },
        { id: 'nested-dark-exclusion', outer: 'light-scope', inner: 'dark-scope' },
        { id: 'runtime', outer: scope, inner: '' },
      ].map((item) => (
        <section
          key={item.id}
          {...withClassName(stylex.props(styles.scope), item.outer)}
          data-owned-filter-scope={item.id}
          style={{ '--color-white': '#ffdfc4' } as CSSProperties}
        >
          <span {...stylex.props(styles.scopeLabel)}>{item.id}</span>
          <div className={item.inner || undefined}>
            <FilterFixture />
          </div>
        </section>
      ))}
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedFilterPill',
  component: FilterFixture,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div {...stylex.props(styles.frame)}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FilterFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Engaged: Story = { args: { aggregate: true, engaged: true } };
export const Aggregate: Story = { args: { aggregate: true } };
export const Scopes: Story = { render: () => <ScopeFixture /> };
