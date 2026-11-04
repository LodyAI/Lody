import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider, useAtomValue } from 'jotai';
import { BetaFeaturesSection } from '@/components/settings/beta-features-setting';
import {
  developerModeEnabledAtom,
  experimentalFeaturesEnabledAtom,
  inboxBetaEnabledAtom,
  inboxFeatureEnabledAtom,
  roostHistoryExperimentEnabledAtom,
  roostHistoryFeatureEnabledAtom,
  semanticShortcutsBetaEnabledAtom,
  semanticShortcutsFeatureEnabledAtom,
} from '@/atoms/settings';
import { settingContainerClass } from '@/components/settings';

/**
 * The section is invisible unless Developer mode is on, so the interesting
 * states cover the remaining independent beta opt-in plus its derived gate.
 */
function GateReadout() {
  const inboxEnabled = useAtomValue(inboxFeatureEnabledAtom);
  const roostHistoryEnabled = useAtomValue(roostHistoryFeatureEnabledAtom);
  const semanticEnabled = useAtomValue(semanticShortcutsFeatureEnabledAtom);
  return (
    <div className="mt-3 space-y-1 text-xs text-muted-foreground">
      <p>
        <span className="font-mono">inboxFeatureEnabledAtom</span> ={' '}
        <span className="font-mono font-semibold">{String(inboxEnabled)}</span>
      </p>
      <p>
        <span className="font-mono">roostHistoryFeatureEnabledAtom</span> ={' '}
        <span className="font-mono font-semibold">{String(roostHistoryEnabled)}</span>
      </p>
      <p>Pointer-aware close shortcut: {String(semanticEnabled)}</p>
    </div>
  );
}

function Harness({
  developerMode,
  inboxBeta,
  roostHistory,
  experimentalMaster,
  semanticShortcuts = false,
}: {
  developerMode: boolean;
  inboxBeta: boolean;
  roostHistory: boolean;
  experimentalMaster: boolean;
  semanticShortcuts?: boolean;
}) {
  // Seeded once per story: a store rebuilt on every render would throw away the
  // switch the viewer just clicked.
  const [store] = useState(() => {
    const next = createStore();
    next.set(developerModeEnabledAtom, developerMode);
    next.set(experimentalFeaturesEnabledAtom, experimentalMaster);
    next.set(inboxBetaEnabledAtom, inboxBeta);
    next.set(roostHistoryExperimentEnabledAtom, roostHistory);
    next.set(semanticShortcutsBetaEnabledAtom, semanticShortcuts);
    return next;
  });

  return (
    <Provider store={store}>
      <div className={settingContainerClass}>
        <BetaFeaturesSection />
        <GateReadout />
      </div>
    </Provider>
  );
}

const meta = {
  title: 'Settings/BetaFeaturesSection',
  component: Harness,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Developer mode off: the section and remaining beta features are absent. */
export const DeveloperModeOff: Story = {
  args: {
    developerMode: false,
    inboxBeta: false,
    roostHistory: false,
    experimentalMaster: true,
  },
};

/** Developer mode on: the Inbox switch is offered, but the feature stays hidden. */
export const AvailableNotEnabled: Story = {
  args: {
    developerMode: true,
    inboxBeta: false,
    roostHistory: false,
    experimentalMaster: true,
  },
};

/** Inbox can be enabled independently while Developer mode stays on. */
export const InboxBetaEnabled: Story = {
  args: {
    developerMode: true,
    inboxBeta: true,
    roostHistory: false,
    experimentalMaster: true,
  },
};

/** Roost can be enabled while the experimental master switch stays off. */
export const RoostHistoryEnabled: Story = {
  args: {
    developerMode: true,
    inboxBeta: false,
    roostHistory: true,
    experimentalMaster: false,
  },
};

/**
 * Opt-ins persist while Developer mode is off, so the features are hidden but
 * the choices are restored when Developer mode comes back.
 */
export const OptInRetainedWhileHidden: Story = {
  args: {
    developerMode: false,
    inboxBeta: true,
    roostHistory: true,
    experimentalMaster: false,
  },
};

export const SemanticShortcutsEnabled: Story = {
  args: {
    developerMode: true,
    inboxBeta: false,
    roostHistory: false,
    experimentalMaster: true,
    semanticShortcuts: true,
  },
};
