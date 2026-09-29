import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { useTranslation } from 'react-i18next';
import { resolveRevealFileLabel } from '@/lib/session-file-actions';
import { SessionFileBinaryPreview } from '@/components/sessions/session-file-binary-preview';

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
      <div className="h-80 w-96 bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionFileBinaryPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

const createSamplePdf = (): Uint8Array => {
  const header = '%PDF-1.4\n';
  const content = 'BT /F1 20 Tf 72 700 Td (PDF preview is ready) Tj ET';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
  ];
  let offset = header.length;
  const offsets = objects.map((object) => {
    const currentOffset = offset;
    offset += object.length;
    return currentOffset;
  });
  const xrefOffset = offset;
  const xref = `xref\n0 6\n0000000000 65535 f \n${offsets.map((position) => `${String(position).padStart(10, '0')} 00000 n \n`).join('')}`;
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
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
