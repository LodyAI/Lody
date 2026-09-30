import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import { SlidersHorizontal } from 'lucide-react';
import { space } from '@lody/ui/tokens/scales.stylex';
import { SettingsAccountEntry } from '@/components/settings/settings-account-entry';
import { settingsSurface as surface } from '@/components/settings/surface';

// A non-square source makes accidental image stretching visible.
const portrait = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#b5caf4"/><circle cx="60" cy="40" r="32" fill="#7268ba"/><circle cx="60" cy="34" r="19" fill="#ffe0bf"/><path d="M38 72a22 22 0 0 1 44 0" fill="#ffe0bf"/><circle cx="53" cy="33" r="2"/><circle cx="67" cy="33" r="2"/><path d="M53 43q7 6 14 0" fill="none" stroke="#a85863" stroke-width="2"/></svg>'
)}`;

const styles = stylex.create({
  nav: { width: '240px', padding: space[3], fontSize: 'var(--ui-font-size, 14px)' },
});

const meta = {
  title: 'Settings/SettingsAccountEntry',
  component: SettingsAccountEntry,
  args: {
    user: { id: 'avatar-layout-fixture', name: 'Alex Example', image: portrait },
    active: true,
    onSelect: () => {},
  },
  decorators: [
    (Story) => (
      <nav aria-label="Settings" {...stylex.props(surface.nav, styles.nav)}>
        <Story />
        <button type="button" {...stylex.props(surface.listRow)}>
          <SlidersHorizontal {...stylex.props(surface.listRowIcon)} />
          <span {...stylex.props(surface.listRowLabel)}>Preferences</span>
        </button>
      </nav>
    ),
  ],
} satisfies Meta<typeof SettingsAccountEntry>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithImage: Story = {};
export const Initials: Story = {
  args: { user: { name: 'Alex Example', image: null } },
};
export const MobileWithImage: Story = { args: { mobile: true } };
