import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import { fn } from 'storybook/test';
import { useTranslation } from 'react-i18next';
import { resolveRevealFileLabel } from '@/lib/session-file-actions';
import { SessionFileBinaryPreview } from '@/components/sessions/session-file-binary-preview';
import { SessionFileNoticeCard } from '@/components/sessions/session-file-error-state';
import { sampleDocx, samplePptx, sampleXlsx } from './fixtures/office-viewer-files';

const styles = stylex.create({
  frame: { width: 'min(100%, 960px)', height: '640px' },
});

const meta = {
  title: 'Sessions/SessionFileBinaryPreview',
  component: SessionFileBinaryPreview,
  render: function BinaryPreviewStory(args) {
    const { t } = useTranslation();
    const fileActions = args.fileActions;
    return (
      <SessionFileBinaryPreview
        {...args}
        fileActions={
          fileActions?.localHost
            ? {
                ...fileActions,
                localHost: {
                  ...fileActions.localHost,
                  revealLabel: resolveRevealFileLabel('darwin', t),
                },
              }
            : fileActions
        }
      />
    );
  },
  decorators: [
    (Story) => (
      <div {...stylex.props(styles.frame)}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionFileBinaryPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

const createSamplePdf = (): Uint8Array => {
  const header = '%PDF-1.4\n';
  const pageTitles = ['Overview', 'Revenue', 'Operations', 'Outlook'];
  const pages = pageTitles.map((title, index) => {
    const content = `BT /F1 30 Tf 72 700 Td (${title}) Tj /F1 16 Tf 0 -60 Td (Quarterly report page ${index + 1}) Tj ET`;
    const pageId = 4 + index * 2;
    const streamId = pageId + 1;
    return {
      pageId,
      streamId,
      page: `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>\nendobj\n`,
      stream: `${streamId} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    };
  });
  const objectCount = 3 + pages.length * 2;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Kids [${pages.map(({ pageId }) => `${pageId} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`,
    '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    ...pages.flatMap(({ page, stream }) => [page, stream]),
  ];
  let offset = header.length;
  const offsets = objects.map((object) => {
    const currentOffset = offset;
    offset += object.length;
    return currentOffset;
  });
  const xrefOffset = offset;
  const xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n${offsets.map((position) => `${String(position).padStart(10, '0')} 00000 n \n`).join('')}`;
  const trailer = `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(`${header}${objects.join('')}${xref}${trailer}`);
};

export const LocalArchive: Story = {
  args: {
    path: '/tmp/build/Lody.zip',
    fileActions: {
      onCopyPath: fn(),
      localHost: {
        openTarget: 'default-app',
        revealLabel: 'Reveal in Finder',
        onOpen: fn(),
        onReveal: fn(),
      },
    },
  },
};

export const RemoteArchive: Story = {
  args: { path: 'build/Lody.zip', fileActions: { onCopyPath: fn() } },
};

export const NativeArchive: Story = {
  args: { path: 'build/package.deb', fileActions: { onCopyPath: fn(), onShare: fn() } },
};

export const NativeSharing: Story = {
  args: {
    path: 'build/package.deb',
    fileActions: { onCopyPath: fn(), onShare: fn(), sharing: true },
  },
};

export const PdfDocument: Story = {
  args: { path: '/tmp/annual-report.pdf', bytes: createSamplePdf() },
};

export const DocxDocument: Story = {
  args: { path: '/tmp/quarterly-report.docx', bytes: sampleDocx() },
};

export const XlsxWorkbook: Story = {
  args: { path: '/tmp/revenue.xlsx', bytes: sampleXlsx() },
};

function PreviousXlsxFallback() {
  const { t } = useTranslation();
  return (
    <SessionFileNoticeCard
      presentation={{
        title: t('sessions.fileDiff.binary.title', 'Binary file'),
        description: t(
          'sessions.fileViewer.binary.message',
          'This binary file cannot be previewed.'
        ),
      }}
    />
  );
}

export const XlsxPreviousFallback: Story = {
  args: { path: '/tmp/revenue.xlsx', bytes: sampleXlsx() },
  render: () => <PreviousXlsxFallback />,
};

export const InactiveXlsxWorkbook: Story = {
  args: { path: '/tmp/revenue.xlsx', bytes: sampleXlsx(), active: false },
};

export const PptxPresentation: Story = {
  args: { path: '/tmp/quarterly-report.pptx', bytes: samplePptx() },
};

// Synthetic 160x90 VP8 color pattern; no captured user media.
export const WebmVideo: Story = {
  args: { path: 'clip.webm' },
  loaders: [
    async () => ({
      bytes: new Uint8Array(
        await (
          await fetch(new URL('./fixtures/video-preview.webm', import.meta.url).href)
        ).arrayBuffer()
      ),
    }),
  ],
  render: (args, { loaded }) => <SessionFileBinaryPreview {...args} bytes={loaded.bytes} />,
};

export const UnsupportedVideo: Story = {
  args: {
    path: 'broken.webm',
    bytes: Uint8Array.of(1, 2, 3),
    fileActions: { onCopyPath: fn(), onShare: fn() },
  },
};

export const InactiveVideo: Story = {
  args: { path: 'clip.webm', bytes: Uint8Array.of(1), active: false },
};
