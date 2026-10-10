import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider, useAtomValue } from 'jotai';
import { ExperimentalFeaturesSection } from '@/components/settings/experimental-features-setting';
import {
  experimentalFeaturesEnabledAtom,
  roostHistoryExperimentEnabledAtom,
  roostHistoryFeatureEnabledAtom,
  reviewAgentExperimentEnabledAtom,
  reviewAgentFeatureEnabledAtom,
} from '@/atoms/settings';
import { settingContainerClass } from '@/components/settings';

/**
 * One master switch, two feature switches, and two derived gates. Unlike the Developer-mode beta section the
 * master switch is always visible, so the "off" state is a real state a user
 * sees rather than an empty region.
 */
function GateReadout() {
  const reviewAgentEnabled = useAtomValue(reviewAgentFeatureEnabledAtom);
  const roostHistoryEnabled = useAtomValue(roostHistoryFeatureEnabledAtom);
  return (
    <p className="mt-3 text-xs text-muted-foreground">
      <span className="font-mono">reviewAgentFeatureEnabledAtom</span> ={' '}
      <span className="font-mono font-semibold">{String(reviewAgentEnabled)}</span>
      {reviewAgentEnabled
        ? ' — the session menu offers Auto review and merge.'
        : ' — no session can be handed to the review agent.'}{' '}
      <span className="font-mono">roostHistoryFeatureEnabledAtom</span> ={' '}
      <span className="font-mono font-semibold">{String(roostHistoryEnabled)}</span>
      {roostHistoryEnabled
        ? ' — new sessions select Roost history.'
        : ' — new sessions select Loro history.'}
    </p>
  );
}

function Harness({
  experimental,
  reviewAgent,
  roostHistory,
}: {
  experimental: boolean;
  reviewAgent: boolean;
  roostHistory: boolean;
}) {
  // Seeded once per story: rebuilding the store on every render would discard
  // the switch the viewer just clicked.
  const [store] = useState(() => {
    const created = createStore();
    created.set(experimentalFeaturesEnabledAtom, experimental);
    created.set(reviewAgentExperimentEnabledAtom, reviewAgent);
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
  args: { experimental: false, reviewAgent: false, roostHistory: false },
};

/** Master switch on, feature not yet opted into. */
export const Expanded: Story = {
  args: { experimental: true, reviewAgent: false, roostHistory: false },
};

/** Both on — the state in which the session menu grows its checkbox. */
export const ReviewAgentEnabled: Story = {
  args: { experimental: true, reviewAgent: true, roostHistory: false },
};

/** Both experimental paths enabled for a new session. */
export const RoostHistoryEnabled: Story = {
  args: { experimental: true, reviewAgent: false, roostHistory: true },
};

/**
 * Master off while the per-feature opt-in is remembered. Turning the master
 * switch back on must restore this choice rather than reset it.
 */
export const OptInRemembered: Story = {
  args: { experimental: false, reviewAgent: true, roostHistory: true },
};
