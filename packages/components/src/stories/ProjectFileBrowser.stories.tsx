import type { Meta, StoryObj } from '@storybook/react';
import { ProjectFileBrowser } from '@/components/files/project-file-browser';
import { createFakeFileWorkspaceProvider } from '@/lib/file-workspace-provider';

const provider = createFakeFileWorkspaceProvider({
  files: ['README.md', 'src/index.ts', 'archive.zip', 'unavailable.txt'].map((path) => ({
    path,
    kind: 'text' as const,
    sourceState: 'live-collaborative' as const,
    ...(path === 'unavailable.txt' ? { unavailableReason: 'metadata-only' as const } : {}),
  })),
  snapshots: {
    'README.md': { kind: 'text', text: '# Workspace\n\nLocal project files.\n' },
    'src/index.ts': { kind: 'text', text: 'export const project = "Lody";\n' },
    'archive.zip': {
      kind: 'binary',
      bytes: new Uint8Array([80, 75, 3, 4]),
      mimeType: 'application/zip',
    },
  },
});

const meta = {
  title: 'Files/ProjectFileBrowser',
  component: ProjectFileBrowser,
  parameters: { layout: 'fullscreen' },
  args: { provider },
  decorators: [
    (Story) => (
      <div style={{ height: 600 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProjectFileBrowser>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Pending: Story = { args: { provider: null, pending: true } };
export const Unavailable: Story = { args: { provider: null, message: 'Files are unavailable.' } };
export const Empty: Story = { args: { provider: createFakeFileWorkspaceProvider({ files: [] }) } };
