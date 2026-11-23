import { colors as uiColors, shadow as uiShadow } from '@lody/ui/tokens/colors.stylex';
import { corner as uiCorner, radius as uiRadius } from '@lody/ui/tokens/scales.stylex';
import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { resolveSessionPullRequestLinkList, type SessionMeta } from '@lody/shared';

import {
  SessionPullRequestLinksPanel,
  unlinkSessionPullRequestFromUi,
  type SessionPullRequestLinksProps,
} from '@/components/sessions/session-pr-links';

/** A Session holding PRs from its branch, a shim-reported one, and links the machine has not confirmed. */
export const linkedPullRequestsMeta = {
  project: { kind: 'github', repoFullName: 'LodyAI/Lody' },
  pullRequests: [
    { url: 'https://github.com/LodyAI/Lody/pull/2994', status: 'merged' },
    { url: 'https://github.com/LodyAI/acp-extension-core/pull/41', status: 'open' },
    { url: 'https://github.com/LodyAI/Lody/pull/3019', status: 'open' },
  ],
  pullRequestState: { 'https://github.com/LodyAI/Lody/pull/3019': { s: 'p', t: 1 } },
  'prLink:https://github.com/lodyai/lody/pull/3019': { k: 'l', o: 's', t: 1 },
  'prLink:https://github.com/lodyai/acp-extension-core/pull/41': { k: 'l', o: 'u', t: 2 },
  'prLink:https://github.com/lodyai/lody/pull/3031': { k: 'l', o: 'u', t: 3 },
  'prLink:https://github.com/lodyai/private-infra/pull/7': { k: 'l', o: 'u', t: 4 },
  'prLinkCheck:https://github.com/lodyai/private-infra/pull/7': { r: 'u', t: 5 },
} as unknown as SessionMeta;

/** Applies the panel's writes to local metadata so unlink can be tried. */
export function useStoryPullRequestLinks(initial: SessionMeta): SessionPullRequestLinksProps {
  const [meta, setMeta] = useState<Record<string, unknown>>(initial as Record<string, unknown>);
  const write = async (patch: Record<string, unknown>) =>
    setMeta((current) => ({ ...current, ...patch }));
  return {
    items: resolveSessionPullRequestLinkList(meta as SessionMeta),
    onOpen: () => {},
    onUnlink: async (url) => {
      await unlinkSessionPullRequestFromUi(meta, url, write);
    },
  };
}

function Harness({ initial }: { initial: SessionMeta }) {
  const links = useStoryPullRequestLinks(initial);
  return (
    <div {...stylex.props(previewStyles.panel)}>
      <SessionPullRequestLinksPanel {...links} />
    </div>
  );
}

const meta = {
  title: 'Sessions/SessionPullRequestLinks',
  component: Harness,
  parameters: { layout: 'centered' },
  excludeStories: ['linkedPullRequestsMeta', 'useStoryPullRequestLinks'],
  args: { initial: linkedPullRequestsMeta },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = { globals: { theme: 'light' } };
export const Dark: Story = { globals: { theme: 'dark' } };

const previewStyles = stylex.create({
  panel: { width: '22rem', borderRadius: uiRadius.large, cornerShape: uiCorner.shape, backgroundColor: uiColors.raisedBackground, boxShadow: uiShadow.popover },
});
