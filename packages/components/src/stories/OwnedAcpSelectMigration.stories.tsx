import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useState, type CSSProperties } from 'react';
import { WandSparkles } from 'lucide-react';
import {
  AcpSessionSelect,
  type AcpSessionSelectOption,
  type AcpSessionSelectProps,
} from '../components/shared/acp-session-select';

const options: AcpSessionSelectOption[] = [
  { value: 'plan', label: 'Plan', description: 'Synthetic planning mode description.' },
  { value: 'agent', label: 'Agent', description: 'Synthetic agent mode description.' },
  { value: 'unavailable', label: 'Unavailable', disabled: true },
];
const longOptions: AcpSessionSelectOption[] = [
  {
    value: 'plan',
    label: 'Synthetic shared-prefix model / 长名称与完整路径 / reasoning-and-planning-mode',
    description: 'Synthetic long description. '.repeat(8),
  },
  ...options.slice(1),
];
const variableValues = {
  '--spacing': '6px',
  '--font-weight-medium': '650',
  '--text-xs': '15px',
  '--leading-tight': '1.9',
} as const;

function SelectionCase({ name, ...props }: Partial<AcpSessionSelectProps> & { name: string }) {
  const [value, setValue] = useState('plan');
  return (
    <section
      data-select-case={name}
      data-selected-value={value}
      style={{ minWidth: 0, maxWidth: 320 }}
    >
      <div style={{ marginBottom: 6 }}>{name}</div>
      <AcpSessionSelect
        value={value}
        onChange={setValue}
        options={options}
        icon={<WandSparkles size={16} />}
        ariaLabel={`Synthetic ${name}`}
        {...props}
      />
      <output style={{ display: 'block', marginTop: 6 }}>Selected: {value}</output>
    </section>
  );
}

function Fixture({
  scenario = 'variants',
}: {
  scenario?: 'variants' | 'restricted' | 'long' | 'caller' | 'root' | 'subtree';
}) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = Object.keys(variableValues).map((name) => ({
      name,
      value: root.style.getPropertyValue(name),
      priority: root.style.getPropertyPriority(name),
    }));
    if (scenario === 'root')
      for (const [name, value] of Object.entries(variableValues))
        root.style.setProperty(name, value);
    setReady(true);
    return () => {
      if (scenario !== 'root') return;
      for (const { name, value, priority } of previous) {
        if (value) root.style.setProperty(name, value, priority);
        else root.style.removeProperty(name);
      }
    };
  }, [scenario]);
  return (
    <main
      data-acp-select-fixture={scenario}
      data-fixture-ready={ready}
      style={{
        ...(scenario === 'subtree' ? (variableValues as CSSProperties) : {}),
        display: 'flex',
        minHeight: 520,
        minWidth: 0,
        flexDirection: 'column',
        gap: 20,
        padding: 20,
        background: 'hsl(var(--background))',
        color: 'hsl(var(--foreground))',
      }}
    >
      {scenario === 'restricted' ? (
        <>
          <SelectionCase name="disabled" disabled />
          <SelectionCase name="single" options={options.slice(0, 1)} />
          <SelectionCase name="empty" options={[]} placeholder="No synthetic options" />
        </>
      ) : scenario === 'long' ? (
        <>
          <SelectionCase name="long-default" options={longOptions} />
          <SelectionCase name="long-compact" variant="compact" options={longOptions} />
        </>
      ) : scenario === 'caller' ? (
        <>
          <SelectionCase
            name="caller-small-last"
            variant="compact"
            className="h-10 h-6 [&_svg]:size-5 [&_span]:font-normal [&_span]:block"
            contentClassName="min-w-[180px]"
          />
          <SelectionCase
            name="caller-large-last"
            variant="compact"
            className="h-6 h-10 [&_svg]:size-5 [&_span]:font-normal [&_span]:block"
            contentClassName="min-w-[180px]"
          />
        </>
      ) : (
        <>
          <SelectionCase name="default" />
          <SelectionCase name="text" variant="text" />
          <SelectionCase name="compact" variant="compact" />
          <SelectionCase name="icon-only" variant="compact" iconOnly />
        </>
      )}
    </main>
  );
}

const meta = {
  title: 'Shared/OwnedAcpSelectMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Variants: Story = { render: () => <Fixture /> };
export const Restricted: Story = { render: () => <Fixture scenario="restricted" /> };
export const LongLabels: Story = { render: () => <Fixture scenario="long" /> };
export const CallerOverrides: Story = { render: () => <Fixture scenario="caller" /> };
export const RootVariables: Story = { render: () => <Fixture scenario="root" /> };
export const SubtreeVariables: Story = { render: () => <Fixture scenario="subtree" /> };
