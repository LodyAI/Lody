import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import { OnboardingCeremony } from '@/components/onboarding/ceremony/ceremony';
import type { OnboardingAudio } from '@/components/onboarding/ceremony/use-onboarding-audio';

const silentScore: Pick<OnboardingAudio, 'start' | 'setEnergy' | 'setLayers'> = {
  start: () => {},
  setEnergy: () => {},
  setLayers: () => {},
};

function CeremonyFixture({ scopedPalette = false }: { scopedPalette?: boolean }) {
  const [finished, setFinished] = useState(false);
  return (
    <div
      data-ceremony-fixture
      data-finished={finished}
      data-scoped-palette={scopedPalette}
      style={
        scopedPalette ? ({ '--color-slate-950': 'rgb(20, 40, 60)' } as CSSProperties) : undefined
      }
    >
      {finished ? (
        <p role="status">Actual ceremony finish callback received.</p>
      ) : (
        <OnboardingCeremony
          playing={false}
          audio={silentScore}
          onFinish={() => setFinished(true)}
        />
      )}
    </div>
  );
}

const meta = {
  title: 'Migration/OnboardingCeremonyStyle',
  component: CeremonyFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof CeremonyFixture>;

export default meta;
type Story = StoryObj<typeof meta>;
export const PausedOpening: Story = {};
export const ScopedPalette: Story = { args: { scopedPalette: true } };
