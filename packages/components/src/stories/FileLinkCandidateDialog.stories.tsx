import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { FileLinkCandidateDialog } from '@/components/sessions/file-link-candidate-dialog';

const candidates = ['main', 'nested/review', 'nested/detached'].map((name, index) => ({
  path: `${name}/docs/guide.md`,
  absolutePath: `/workspace/sample/${name}/docs/guide.md`,
  worktreeRoot: `/workspace/sample/${name}`,
  branch: index === 2 ? null : `refs/heads/${name}`,
  head: String(index + 1).repeat(40),
  mtimeMs: Date.UTC(2026, 9, 21, 12, index),
}));

export default {
  title: 'Sessions/File link candidates',
  component: FileLinkCandidateDialog,
} satisfies Meta<typeof FileLinkCandidateDialog>;

export const Ambiguous: StoryObj<typeof FileLinkCandidateDialog> = {
  render: function CandidateChoices() {
    const [selected, setSelected] = useState<string | null>(null);
    return selected === null ? (
      <FileLinkCandidateDialog
        candidates={candidates}
        onSelect={(candidate) => setSelected(candidate.absolutePath)}
        onClose={() => setSelected('Cancelled')}
      />
    ) : (
      <p>{selected}</p>
    );
  },
};
