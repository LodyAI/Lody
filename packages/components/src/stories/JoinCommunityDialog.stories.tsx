import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { ExternalLink } from 'lucide-react';
import {
  JoinCommunityButton,
  JoinCommunityDialog,
} from '@/components/settings/join-community-dialog';
import { CompactRow, CompactSection } from '@/components/settings/compact-layout';
import { settingContainerClass } from '@/components/settings';
import { Button } from '@/ui';
const storyLayout = stylex.create({
  frame: {
    'margin-right': 'calc(var(--spacing) * 1)',
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
});

/**
 * Both entry points — Settings → About → Community and the sidebar help menu —
 * render this exact component with the bundled QR asset, so what Storybook shows
 * is what the desktop and mobile apps show. No fixture image is substituted.
 */
const meta: Meta<typeof JoinCommunityDialog> = {
  title: 'Components/JoinCommunityDialog',
  component: JoinCommunityDialog,
  args: {
    open: true,
    onOpenChange: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof JoinCommunityDialog>;

/** The dialog as the sidebar help menu opens it. */
export const Open: Story = {};

export const Closed: Story = {
  args: {
    open: false,
  },
};

/**
 * The About row that owns the highlighted (primary) trigger, shown beside the
 * outline link rows it sits above so the emphasis difference is visible.
 */
export const SettingsAboutRow: StoryObj = {
  render: () => (
    <div className={settingContainerClass}>
      <CompactSection>
        <CompactRow label="Community">
          <JoinCommunityButton />
        </CompactRow>
        <CompactRow label="Download apps">
          <Button variant="secondary" size="small">
            <ExternalLink {...stylex.props(storyLayout.frame)} />
            Open download page
          </Button>
        </CompactRow>
        <CompactRow label="Website">
          <Button variant="secondary" size="small">
            <ExternalLink {...stylex.props(storyLayout.frame)} />
            Visit website
          </Button>
        </CompactRow>
      </CompactSection>
    </div>
  ),
};
