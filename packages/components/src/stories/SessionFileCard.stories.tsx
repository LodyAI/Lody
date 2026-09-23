import type { Meta, StoryObj } from '@storybook/react';
import { getServerNow, type SessionFilePayload } from '@lody/shared';
import { SESSION_FILE_RETENTION_MS } from '@/lib/session-file-presentation';
import { SessionFileCard, SessionFileCardList } from '@/components/ai-gui/session-file-card';

const baseFile = (overrides: Partial<SessionFilePayload>): SessionFilePayload => ({
  type: 'file',
  fileId: 'file-1',
  fileName: 'report.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2_400_000,
  sha256: 'a'.repeat(64),
  textPreview: false,
  transport: 'r2',
  uploadedAt: getServerNow(),
  ...overrides,
});

const meta = {
  title: 'AI/SessionFileCard',
  component: SessionFileCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof SessionFileCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const wrap = (content: React.ReactNode) => (
  <div className="w-[28rem] rounded-xl border border-dashed border-border/60 bg-muted/20 p-4">
    {content}
  </div>
);

export const DownloadablePdf: Story = {
  args: { file: baseFile({ fileName: 'quarterly-report.pdf', mimeType: 'application/pdf' }) },
  render: (args) => wrap(<SessionFileCard {...args} />),
};

export const PreviewableMarkdown: Story = {
  args: {
    file: baseFile({
      fileId: 'file-md',
      fileName: 'README.md',
      mimeType: 'text/markdown',
      sizeBytes: 12_400,
      textPreview: true,
    }),
  },
  render: (args) => wrap(<SessionFileCard {...args} />),
};

const htmlArgs = {
  file: baseFile({
    fileId: 'file-html',
    fileName: 'lody-one-flyer.html',
    mimeType: 'text/html',
    sizeBytes: 16_300,
    textPreview: true,
  }),
  onPreview: () => {},
  onDownload: () => {},
};

/**
 * An HTML attachment's click opens the rendered page, so the card carries a
 * second action for the source file — the only card variant with two controls.
 */
export const PreviewableHtml: Story = {
  args: htmlArgs,
  render: (args) => wrap(<SessionFileCard {...args} />),
};

/** That second action spins on its own while the source download is in flight. */
export const PreviewableHtmlDownloading: Story = {
  args: { ...htmlArgs, isDownloading: true },
  render: (args) => wrap(<SessionFileCard {...args} />),
};

export const PendingLocalTransport: Story = {
  args: {
    file: baseFile({
      fileId: 'file-local',
      fileName: 'screen-recording.mov',
      mimeType: 'video/quicktime',
      sizeBytes: 84_000_000,
      transport: 'local',
      machineId: 'machine-abc',
    }),
    pendingMachineName: "Leon's MacBook",
  },
  render: (args) => wrap(<SessionFileCard {...args} />),
};

export const Expired: Story = {
  args: {
    file: baseFile({
      fileId: 'file-expired',
      fileName: 'old-archive.zip',
      mimeType: 'application/zip',
      sizeBytes: 9_800_000,
      // Uploaded just over the retention window ago.
      uploadedAt: getServerNow() - SESSION_FILE_RETENTION_MS - 1000,
    }),
  },
  render: (args) => wrap(<SessionFileCard {...args} />),
};

export const Downloading: Story = {
  args: {
    file: baseFile({ fileName: 'dataset.bin', mimeType: 'application/octet-stream' }),
    isDownloading: true,
  },
  render: (args) => wrap(<SessionFileCard {...args} />),
};

/** All the extension-driven icon buckets at a glance. */
export const IconsByExtension: Story = {
  args: { file: baseFile({}) },
  render: () =>
    wrap(
      <div className="flex flex-col gap-2">
        {[
          { fileName: 'notes.txt', mimeType: 'text/plain', textPreview: true },
          { fileName: 'main.ts', mimeType: 'text/x-typescript', textPreview: true },
          { fileName: 'data.json', mimeType: 'application/json', textPreview: true },
          { fileName: 'sheet.csv', mimeType: 'text/csv', textPreview: true },
          { fileName: 'bundle.zip', mimeType: 'application/zip' },
          { fileName: 'photo.heic', mimeType: 'image/heic' },
          { fileName: 'track.mp3', mimeType: 'audio/mpeg' },
          { fileName: 'clip.mp4', mimeType: 'video/mp4' },
          { fileName: 'doc.pdf', mimeType: 'application/pdf' },
          { fileName: 'unknown.bin', mimeType: 'application/octet-stream' },
        ].map((spec, index) => (
          <SessionFileCard
            key={spec.fileName}
            file={baseFile({ fileId: `icon-${index}`, ...spec })}
          />
        ))}
      </div>
    ),
};

/** Adjacent file blocks aggregate into one list (decision #3). */
export const AggregatedList: Story = {
  args: { file: baseFile({}) },
  render: () =>
    wrap(
      <SessionFileCardList align="start">
        <SessionFileCard
          file={baseFile({
            fileId: 'g1',
            fileName: 'design-spec.md',
            textPreview: true,
            mimeType: 'text/markdown',
            sizeBytes: 8_200,
          })}
        />
        <SessionFileCard
          file={baseFile({
            fileId: 'g2',
            fileName: 'api-schema.json',
            textPreview: true,
            mimeType: 'application/json',
            sizeBytes: 41_000,
          })}
        />
        <SessionFileCard
          file={baseFile({
            fileId: 'g3',
            fileName: 'mockups.zip',
            mimeType: 'application/zip',
            sizeBytes: 18_400_000,
          })}
        />
      </SessionFileCardList>
    ),
};
