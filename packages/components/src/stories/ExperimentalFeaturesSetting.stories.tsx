import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider } from 'jotai';
import { ExperimentalFeaturesSection } from '@/components/settings/experimental-features-setting';
import { experimentalFeaturesEnabledAtom } from '@/atoms/settings';
import { settingContainerClass } from '@/components/settings';

/** The master switch is always visible, so its off state is a real state users see. */
function Harness({ experimental }: { experimental: boolean }) {
  // Seeded once per story: rebuilding the store on every render would discard
  // the switch the viewer just clicked.
  const [store] = useState(() => {
    const created = createStore();
    created.set(experimentalFeaturesEnabledAtom, experimental);
    return created;
  });

  return (
    <Provider store={store}>
      <div className={settingContainerClass}>
        <ExperimentalFeaturesSection />
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
  args: { experimental: false },
};

/** Master switch on; developer-only feature switches live in the beta section. */
export const Enabled: Story = {
  args: { experimental: true },
};
