import { useMemo, useState } from 'react';
import { Button } from '@lody/ui/button';
import { AgentFileLinkIndexContext } from '@/components/ai-gui/agent-file-link-context';
import { createAgentFileLinkIndex } from '@/lib/agent-file-link-index';
import type { Meta, StoryObj } from '@storybook/react';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';

const meta = {
  title: 'AI/MarkdownCodexFileCitations',
  component: MarkdownRenderer,
  args: {
    text: 'Files are ready.\n\n:codex-file-citation{path="\n/tmp/exports/预算 draft.xlsx\n" purpose="output" artifact_kind="workbook"}\n\n:codex-file-citation{path="/tmp/exports/report.pdf" purpose="output"}\n\nReview the files before sharing.',
  },
} satisfies Meta<typeof MarkdownRenderer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CopyPath: Story = {};
export const OpenFile: Story = {
  args: { onAgentFileLinkClick: (href) => alert(decodeURIComponent(href)) },
};
export const Incomplete: Story = {
  args: { text: ':codex-file-citation{path="/tmp/exports/report.pdf"' },
};

function IndexedPathsPreview() {
  const index = useMemo(createAgentFileLinkIndex, []);
  const [indexed, setIndexed] = useState(false);
  return (
    <AgentFileLinkIndexContext.Provider value={index}>
      <Button
        onClick={() => {
          index.setFiles(
            indexed
              ? []
              : ['src/app.ts', 'docs/guide.md', 'out/report.pdf'].map((path) => ({
                  path,
                  kind: 'text' as const,
                  sourceState: 'live-readonly' as const,
                }))
          );
          setIndexed(!indexed);
        }}
      >
        {indexed ? 'Remove indexed files' : 'Confirm indexed files'}
      </Button>
      <MarkdownRenderer
        text={
          'Absolute: `/tmp/report.pdf`\n\nCandidates: src/app.ts, `missing/file.ts`, [Guide](./docs/guide.md#L8)\n\n:codex-file-citation{path="out/report.pdf"}'
        }
        onAgentFileLinkClick={(href) => alert(href)}
      />
    </AgentFileLinkIndexContext.Provider>
  );
}
export const IndexedPaths: Story = { render: () => <IndexedPathsPreview /> };
