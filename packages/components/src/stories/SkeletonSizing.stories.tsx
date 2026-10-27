import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Skeleton, type SkeletonProps } from '@lody/ui/skeleton';

const cases: { name: string; props: SkeletonProps }[] = [
  { name: 'default', props: {} },
  { name: 'width-only', props: { width: 96 } },
  { name: 'height-only', props: { height: 28 } },
  { name: 'both', props: { width: '60%', height: 20 } },
  { name: 'zero-width', props: { width: 0, height: 20 } },
  { name: 'zero-height', props: { width: 96, height: 0 } },
  { name: 'block-width-only', props: { shape: 'block', width: 96 } },
  { name: 'circle-height-only', props: { shape: 'circle', height: 28 } },
];

function SizingFixture() {
  const [step, setStep] = useState(0);
  const changing: SkeletonProps[] = [
    { width: 96 },
    { height: 28 },
    { width: '60%', height: 20 },
    {},
    { width: 0, height: 20 },
  ];
  return (
    <main style={{ maxWidth: 640, padding: 16 }}>
      <h1>Production Skeleton sizing</h1>
      <p>Optional dimensions keep the shape defaults; explicit zero remains zero.</p>
      {cases.map(({ name, props }) => (
        <section key={name} style={{ marginBlock: 12 }}>
          <p>{name}</p>
          <div style={{ width: 240, minHeight: 32 }}>
            <Skeleton {...props} data-skeleton-case={name} />
          </div>
        </section>
      ))}
      <button type="button" onClick={() => setStep((value) => (value + 1) % changing.length)}>
        Next sizing state
      </button>
      <output data-sizing-step={step}>Sizing state {step}</output>
      <div style={{ width: 240, minHeight: 32 }}>
        <Skeleton {...changing[step]} data-skeleton-case="changing" />
      </div>
    </main>
  );
}

const meta = {
  title: 'UI/SkeletonSizing',
  component: SizingFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SizingFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const OptionalDimensions: Story = {};
