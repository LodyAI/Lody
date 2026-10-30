import type { Meta, StoryObj } from '@storybook/react';
import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Check, X } from 'lucide-react';

import { Button } from '../ui/button';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';

const meta = {
  title: 'Code Review Helper/ButtonToggleMigration',
  parameters: { layout: 'fullscreen', controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Scope({ children }: { children: ReactNode }) {
  return (
    <main
      className="crh-shell dark"
      data-button-toggle-migration
      style={{
        minHeight: '100vh',
        padding: 24,
        display: 'grid',
        gap: 16,
        alignContent: 'start',
        justifyItems: 'start',
        background: 'hsl(var(--background))',
        color: 'hsl(var(--foreground))',
      }}
    >
      {children}
    </main>
  );
}

export const ButtonVariants: Story = {
  render: () => (
    <Scope>
      {(['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const).map(
        (variant) => (
          <Button key={variant} data-case={variant} variant={variant}>
            <Check />
            {variant}
          </Button>
        )
      )}
      <Button disabled>Disabled</Button>
    </Scope>
  ),
};
export const ButtonSizes: Story = {
  render: () => (
    <Scope>
      {(['default', 'sm', 'lg', 'icon'] as const).map((size) => (
        <Button key={size} data-case={size} size={size} aria-label={size}>
          <Check />
          {size !== 'icon' && size}
        </Button>
      ))}
      <Button className="h-12 gap-4 rounded-none px-6 py-3 bg-info text-background">
        Utility caller
      </Button>
      <Button
        style={{ height: 47, gap: 11, paddingInline: 19, backgroundColor: 'rgb(24, 72, 91)' }}
      >
        Inline caller
      </Button>
    </Scope>
  ),
};
export const ButtonDefaults: Story = {
  render: () => (
    <Scope>
      <Button data-case="omitted">Omitted</Button>
      <Button data-case="undefined" variant={undefined} size={undefined}>
        Undefined
      </Button>
      <Button data-case="null" variant={null} size={null}>
        Null
      </Button>
      <Button
        data-case="unknown"
        variant={'unknown' as ComponentProps<typeof Button>['variant']}
        size={'unknown' as ComponentProps<typeof Button>['size']}
      >
        Unknown
      </Button>
    </Scope>
  ),
};
export const ButtonSlot: Story = {
  render: () => (
    <Scope>
      <Button asChild data-case="slot-default">
        <a href="#local-default">Default anchor</a>
      </Button>
      <Button asChild data-case="slot-classes">
        <a
          href="#local-classes"
          className="block h-7 gap-5 whitespace-normal rounded-none border-4 bg-background px-2 py-1 text-info underline-offset-2"
        >
          <Check />
          Child utility classes
        </a>
      </Button>
      <Button asChild data-case="slot-inline">
        <a
          href="#local-inline"
          style={{
            display: 'block',
            height: 51,
            gap: 13,
            borderRadius: 19,
            paddingInline: 23,
            backgroundColor: 'rgb(27, 80, 95)',
          }}
        >
          <Check />
          Child inline styles
        </a>
      </Button>
    </Scope>
  ),
};
export const ToggleVariants: Story = {
  render: () => (
    <Scope>
      {(['default', 'outline'] as const).map((variant) => (
        <ToggleGroup
          key={variant}
          data-case={variant}
          type="single"
          defaultValue="first"
          variant={variant}
          aria-label={variant}
        >
          <ToggleGroupItem value="first" aria-label="First">
            <Check />
          </ToggleGroupItem>
          <ToggleGroupItem value="second" aria-label="Second">
            <X />
          </ToggleGroupItem>
          <ToggleGroupItem value="disabled" disabled>
            Disabled
          </ToggleGroupItem>
        </ToggleGroup>
      ))}
      <ToggleGroup type="multiple" defaultValue={['first']} aria-label="Multiple">
        <ToggleGroupItem value="first">First</ToggleGroupItem>
        <ToggleGroupItem value="second">Second</ToggleGroupItem>
      </ToggleGroup>
    </Scope>
  ),
};
export const ToggleSizes: Story = {
  render: () => (
    <Scope>
      {(['default', 'sm', 'lg'] as const).map((size) => (
        <ToggleGroup
          key={size}
          data-case={size}
          type="single"
          defaultValue="first"
          size={size}
          aria-label={size}
        >
          <ToggleGroupItem value="first">First</ToggleGroupItem>
          <ToggleGroupItem value="second" className="h-12 gap-4 rounded-none px-6">
            Caller
          </ToggleGroupItem>
        </ToggleGroup>
      ))}
    </Scope>
  ),
};
export const ToggleSlot: Story = {
  render: () => (
    <Scope>
      <ToggleGroup type="single" defaultValue="first" aria-label="Slot items">
        <ToggleGroupItem value="first" asChild data-case="slot-default">
          <span>Default slot</span>
        </ToggleGroupItem>
        <ToggleGroupItem value="second" asChild data-case="slot-classes">
          <span className="block h-9 gap-5 whitespace-normal rounded-none px-6 bg-info text-info">
            Child classes
          </span>
        </ToggleGroupItem>
        <ToggleGroupItem value="third" asChild data-case="slot-inline">
          <span
            style={{ display: 'block', height: 49, gap: 17, borderRadius: 12, paddingInline: 21 }}
          >
            Child inline
          </span>
        </ToggleGroupItem>
      </ToggleGroup>
    </Scope>
  ),
};

const fieldCases = {
  explicit: {
    width: 'calc(var(--spacing) * 8)',
    height: 'calc(var(--spacing) * 7)',
    color: 'hsl(var(--muted-foreground))',
  },
  zero: { width: 0, height: 0, color: 'rgb(20, 110, 160)' },
  initial: { width: 'initial', height: 'initial', color: 'initial' },
  inherit: { width: 'inherit', height: 'inherit', color: 'inherit' },
  unset: { width: 'unset', height: 'unset', color: 'unset' },
  revert: { width: 'revert', height: 'revert', color: 'revert' },
  revertLayer: { width: 'revert-layer', height: 'revert-layer', color: 'revert-layer' },
  fallback: {
    width: 'var(--missing-button-width, inherit)',
    height: 'var(--missing-button-height, initial)',
    color: 'var(--missing-button-ink, inherit)',
  },
  omitted: {},
} satisfies Record<string, CSSProperties>;

function PhysicalFields() {
  const [mode, setMode] = useState<keyof typeof fieldCases>('explicit');
  const [calls, setCalls] = useState({ native: 0, parent: 0, child: 0 });
  const nativeRef = useRef<HTMLButtonElement>(null);
  const slotRef = useRef<HTMLButtonElement>(null);
  const [refs, setRefs] = useState('');
  useLayoutEffect(() => setRefs(`${nativeRef.current?.tagName}/${slotRef.current?.tagName}`), []);
  const fields: CSSProperties = fieldCases[mode];
  const caller: CSSProperties = { width: 43, height: 37, color: 'rgb(190, 80, 35)' };
  return (
    <Scope>
      <div data-field-controls style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {Object.keys(fieldCases).map((key) => (
          <button
            key={key}
            data-set-fields={key}
            onClick={() => setMode(key as keyof typeof fieldCases)}
          >
            {key}
          </button>
        ))}
      </div>
      <section data-physical-field-fixture data-mode={mode} style={{ display: 'grid', gap: 8 }}>
        <div style={{ width: 190, height: 70, color: 'rgb(37, 130, 180)' }}>
          <Button
            ref={nativeRef}
            data-field-case="native"
            size="icon"
            width={fields.width}
            height={fields.height}
            labelColor={fields.color}
            onClick={() => setCalls((x) => ({ ...x, native: x.native + 1 }))}
          >
            <Check className="size-3.5" />
          </Button>
        </div>
        <div style={{ width: 190, height: 70, color: 'rgb(37, 130, 180)' }}>
          <Button
            data-field-case="caller-style"
            width={fields.width}
            height={fields.height}
            labelColor={fields.color}
            style={caller}
          >
            Caller
          </Button>
        </div>
        <div style={{ width: 190, height: 70, color: 'rgb(37, 130, 180)' }}>
          <Button
            ref={slotRef}
            asChild
            data-field-case="slot"
            width={fields.width}
            height={fields.height}
            labelColor={fields.color}
            onClick={() => setCalls((x) => ({ ...x, parent: x.parent + 1 }))}
          >
            <a
              href="#physical-slot"
              style={{ width: 61, height: 41, color: 'rgb(130, 70, 160)' }}
              onClick={(event) => {
                event.preventDefault();
                setCalls((x) => ({ ...x, child: x.child + 1 }));
              }}
            >
              Child
            </a>
          </Button>
        </div>
        <Button
          data-field-case="disabled"
          disabled
          width={fields.width}
          height={fields.height}
          labelColor={fields.color}
        >
          Disabled
        </Button>
        <Button data-field-case="omitted" style={{ width: 57, height: 39 }}>
          Omitted
        </Button>
        <output data-field-calls>
          {calls.native}/{calls.parent}/{calls.child}
        </output>
        <output data-field-refs>{refs}</output>
      </section>
    </Scope>
  );
}
export const ButtonPhysicalFields: Story = { render: () => <PhysicalFields /> };
