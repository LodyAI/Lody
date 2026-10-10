import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider, useAtomValue } from 'jotai';
import { ExperimentalFeaturesSection } from '@/components/settings/experimental-features-setting';
import {
  experimentalFeaturesEnabledAtom,
  roostHistoryExperimentEnabledAtom,
  roostHistoryFeatureEnabledAtom,
} from '@/atoms/settings';
import { settingContainerClass } from '@/components/settings';

/**
 * One master switch, one feature switch, and its derived gate. The
 * master switch is always visible, so the "off" state is a real state a user
 * sees rather than an empty region.
 */
function GateReadout() {
  const roostHistoryEnabled = useAtomValue(roostHistoryFeatureEnabledAtom);
  return (
    <p className="mt-3 text-xs text-muted-foreground">
      <span className="font-mono">roostHistoryFeatureEnabledAtom</span> ={' '}
      <span className="font-mono font-semibold">{String(roostHistoryEnabled)}</span>
      {roostHistoryEnabled
        ? ' — new sessions select Roost history.'
        : ' — new sessions select Loro history.'}
    </p>
  );
}

function Harness({ experimental, roostHistory }: { experimental: boolean; roostHistory: boolean }) {
  // Seeded once per story: rebuilding the store on every render would discard
  // the switch the viewer just clicked.
  const [store] = useState(() => {
    const created = createStore();
    created.set(experimentalFeaturesEnabledAtom, experimental);
    created.set(roostHistoryExperimentEnabledAtom, roostHistory);
    return created;
  });

  return (
    <Provider store={store}>
      <div className={settingContainerClass}>
        <ExperimentalFeaturesSection />
        <GateReadout />
      </div>
    </Provider>
  );
}

const meta = {
  title: 'Settings/ExperimentalFeaturesSetting',
  component: Harness,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default for everyone: the master switch, and nothing else. */
export const Collapsed: Story = {
  args: { experimental: false, roostHistory: false },
};

/** Master switch on, feature not yet opted into. */
export const Expanded: Story = {
  args: { experimental: true, roostHistory: false },
};

/** Roost history enabled for new sessions. */
export const RoostHistoryEnabled: Story = {
  args: { experimental: true, roostHistory: true },
};

/**
 * Master off while the per-feature opt-in is remembered. Turning the master
 * switch back on must restore this choice rather than reset it.
 */
export const OptInRemembered: Story = {
  args: { experimental: false, roostHistory: true },
};
