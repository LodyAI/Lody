import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { UpdateChangelogDialog } from '@/components/update-changelog-dialog';

const RELEASE_NOTES = [
  '## Highlights',
  '- Sessions reconnect faster after the machine sleeps',
  '- The file tree keeps its scroll position when a session updates',
  '### Fixes',
  '- Fixed a crash when opening a diff for a deleted file',
  '- Fixed duplicated notifications on Windows',
].join('\n');

const meta: Meta<typeof UpdateChangelogDialog> = {
  title: 'Components/UpdateChangelogDialog',
  component: UpdateChangelogDialog,
  args: {
    open: true,
    onOpenChange: fn(),
    version: '1.4.2',
    releaseDate: '2026-08-04T10:00:00.000Z',
    notes: RELEASE_NOTES,
    onOpenChangelogSite: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof UpdateChangelogDialog>;

export const WithReleaseNotes: Story = {};

export const WithoutReleaseDate: Story = {
  args: { releaseDate: undefined },
};

// No notes in the payload: the dialog says so and offers the website instead of
// showing an empty body.
export const WithoutReleaseNotes: Story = {
  args: { notes: null },
};

export const Closed: Story = {
  args: { open: false },
};
