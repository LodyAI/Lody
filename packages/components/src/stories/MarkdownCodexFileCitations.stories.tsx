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
