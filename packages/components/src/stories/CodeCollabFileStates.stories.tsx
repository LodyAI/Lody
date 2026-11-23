import type { Meta, StoryObj } from '@storybook/react';
import type { SessionMeta } from '@lody/shared';
import { useMemo } from 'react';
import { fn } from 'storybook/test';
import { FileTreeView } from '@/components/sessions/components/file-tree-view';
import { SessionFileContentView } from '@/components/sessions/session-file-content-view';
import { SessionFileErrorState } from '@/components/sessions/session-file-error-state';
import {
  createFakeSessionFileProvider,
  type SessionFileProviderEntry,
} from '@/lib/session-file-provider';
import { getSessionFileEntryModel } from '@/lib/session-file-provider-view-model';

const fileTreeStateMatrixEntries = [
  // Live collaborative
  {
    fileId: 't:src-app',
    path: 'src/app.ts',
    kind: 'text',
    sourceState: 'live-collaborative',
    sizeBytes: 4_200,
  },
  {
    fileId: 't:src-utils',
    path: 'src/utils/format.ts',
    kind: 'text',
    sourceState: 'live-collaborative',
    sizeBytes: 1_840,
    executable: false,
  },
  // Live read-only
  {
    fileId: 't:vendor-legacy',
    path: 'src/vendor/legacy.ts',
    kind: 'text',
    sourceState: 'live-readonly',
    readonly: true,
    sizeBytes: 6_120,
  },
  // Historical / turn snapshot
  {
    fileId: 't:docs-history',
    path: 'docs/turn-history.md',
    kind: 'text',
    sourceState: 'historical-turn',
    readonly: true,
  },
  // Host-offline
  {
    fileId: 't:readme',
    path: 'README.md',
    kind: 'text',
    sourceState: 'host-offline',
    readonly: true,
  },
  // Cached metadata-only (no content)
  {
    fileId: 't:metadata-only',
    path: 'src/cached-only.ts',
    kind: 'text',
    sourceState: 'degraded',
    readonly: true,
    unavailableReason: 'metadata-only',
  },
  // Missing text frontiers
  {
    fileId: 't:missing-history',
    path: 'docs/lost-history.md',
    kind: 'text',
    sourceState: 'historical-turn',
    readonly: true,
    unavailableReason: 'missing-text-frontiers',
  },
  // Binary
  {
    fileId: 'b:assets-banner',
    path: 'assets/banner.png',
    kind: 'binary',
    sourceState: 'live-readonly',
    readonly: true,
    sizeBytes: 220_000,
  },
  // Large blob
  {
    fileId: 'b:assets-clip',
    path: 'assets/clip.mov',
    kind: 'large',
    sourceState: 'live-readonly',
    readonly: true,
    sizeBytes: 130 * 1024 * 1024,
    unavailableReason: 'blob-too-large',
  },
  // Oversized text
  {
    fileId: 't:oversized',
    path: 'src/generated/big.json',
    kind: 'text',
    sourceState: 'degraded',
    readonly: true,
    sizeBytes: 12 * 1024 * 1024,
    unavailableReason: 'text-too-large',
  },
  // Long line
  {
    fileId: 't:long-line',
    path: 'src/snapshots/fixture.ts',
    kind: 'text',
    sourceState: 'degraded',
    readonly: true,
    unavailableReason: 'line-too-long',
  },
  // Unsupported encoding
  {
    fileId: 't:encoding',
    path: 'fixtures/latin1.txt',
    kind: 'text',
    sourceState: 'degraded',
    readonly: true,
    unavailableReason: 'unsupported-encoding',
  },
  // Symlink to known target
  {
    fileId: 'l:link-known',
    path: 'links/current.ts',
    kind: 'symlink',
    sourceState: 'live-readonly',
    readonly: true,
    linkTarget: 'src/app.ts',
  },
  // Dangling symlink
  {
    fileId: 'l:link-dangling',
    path: 'links/missing.ts',
    kind: 'symlink',
    sourceState: 'degraded',
    readonly: true,
    unavailableReason: 'metadata-only',
  },
  // Special node
  {
    fileId: 's:dev-fifo',
    path: 'tmp/fifo',
    kind: 'special',
    sourceState: 'degraded',
    readonly: true,
    specialKind: 'fifo',
    unavailableReason: 'unsupported-special',
  },
  // Permission-denied
  {
    fileId: 't:secret',
    path: 'private/keys.env',
    kind: 'text',
    sourceState: 'degraded',
    readonly: true,
    unavailableReason: 'permission-denied',
  },
  // Locked
  {
    fileId: 't:locked',
    path: 'tmp/locked.txt',
    kind: 'text',
    sourceState: 'degraded',
    readonly: true,
    unavailableReason: 'locked',
  },
  // Path collision
  {
    fileId: 't:path-collision',
    path: 'src/Case.ts',
    kind: 'text',
    sourceState: 'degraded',
    readonly: true,
    unavailableReason: 'path-collision',
  },
  // Transient IO
  {
    fileId: 't:transient',
    path: 'src/flaky-mount.ts',
    kind: 'text',
    sourceState: 'degraded',
    readonly: true,
    unavailableReason: 'transient-io',
  },
] satisfies readonly SessionFileProviderEntry[];

const fileTreeStorySession = {
  id: 'storybook-code-collab-file-states',
  machineId: 'storybook-machine',
  createdAt: '2026-05-09T00:00:00.000Z',
  userId: 'storybook-user',
  cliType: 'codex',
  agentType: 'codex',
} as unknown as SessionMeta;

function FileTreeStateMatrixStory() {
  const provider = useMemo(
    () =>
      createFakeSessionFileProvider({
        sourceState: 'live-collaborative',
        files: fileTreeStateMatrixEntries,
        snapshots: {
          'src/app.ts': {
            kind: 'text',
            text: ['export function main() {', '  // ...', '}', ''].join('\n'),
          },
        },
      }),
    []
  );

  return (
    <div className="grid h-[640px] w-[920px] grid-cols-[300px_minmax(0,1fr)] overflow-hidden rounded-md border border-border bg-background">
      <aside className="min-w-0 border-r border-border">
        <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
          File tree mixes live, host-offline, historical, and degraded entries so reviewers can scan
          them all in one place.
        </div>
        <FileTreeView
          session={fileTreeStorySession}
          fileProvider={provider}
          autoCodeCollab={false}
          handleOpenFile={fn()}
        />
      </aside>
      <main className="min-w-0 overflow-y-auto">
        <div className="border-b border-border px-3 py-2 text-sm font-medium text-foreground">
          Per-file source states
        </div>
        <div className="divide-y divide-border">
          {fileTreeStateMatrixEntries.map((entry) => {
            const model = getSessionFileEntryModel(entry);
            return (
              <div
                key={entry.fileId}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 text-xs"
              >
                <span className="min-w-0 truncate text-foreground" title={entry.path}>
                  {entry.path}
                </span>
                <span className="text-muted-foreground">
                  {model.unavailableLabel ?? model.sourceLabel}
                </span>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}

function UnsupportedFileStory({
  entry,
  description,
}: {
  readonly entry: SessionFileProviderEntry;
  readonly description: string;
}) {
  const provider = useMemo(
    () =>
      createFakeSessionFileProvider({
        sourceState: 'live-collaborative',
        files: [entry],
      }),
    [entry]
  );

  return (
    <div className="flex h-[300px] w-[640px] flex-col overflow-hidden rounded-md border border-border bg-background">
      <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
        {description}
      </div>
      <div className="min-h-0 flex-1">
        <SessionFileContentView
          sessionId={fileTreeStorySession.id}
          session={fileTreeStorySession}
          filePath={entry.path}
          {...(entry.fileId === undefined ? {} : { fileId: entry.fileId })}
          fileProvider={provider}
        />
      </div>
    </div>
  );
}

function TextBufferTooLargeStory() {
  return (
    <UnsupportedFileStory
      entry={{
        fileId: 't:huge-generated',
        path: 'src/generated/huge.ts',
        kind: 'text',
        sourceState: 'degraded',
        readonly: true,
        sizeBytes: 12 * 1024 * 1024,
        unavailableReason: 'text-too-large',
      }}
      description="Realtime text buffers are limited to 10 MiB. Files past the limit stay metadata-only with a clear repair hint, instead of trying to load oversized content into the editor."
    />
  );
}

function BlobUploadTooLargeStory() {
  return (
    <UnsupportedFileStory
      entry={{
        fileId: 'b:training-clip',
        path: 'assets/training-clip.mov',
        kind: 'large',
        sourceState: 'live-readonly',
        readonly: true,
        sizeBytes: 130 * 1024 * 1024,
        unavailableReason: 'blob-too-large',
      }}
      description="Code Collab refuses to upload blobs larger than 100 MiB. The provider keeps the metadata visible and points reviewers to external storage instead."
    />
  );
}

function LineTooLongStory() {
  return (
    <UnsupportedFileStory
      entry={{
        fileId: 't:single-line',
        path: 'src/snapshots/fixture.min.js',
        kind: 'text',
        sourceState: 'degraded',
        readonly: true,
        sizeBytes: 4_200_000,
        unavailableReason: 'line-too-long',
      }}
      description="Realtime text rejects files with a single line over 1 MiB / 200,000 UTF-16 code units. The view stays read-only with a non-blocking explanation."
    />
  );
}

function UnsupportedEncodingStory() {
  return (
    <UnsupportedFileStory
      entry={{
        fileId: 't:latin1-txt',
        path: 'fixtures/latin1.txt',
        kind: 'text',
        sourceState: 'degraded',
        readonly: true,
        sizeBytes: 1_280,
        unavailableReason: 'unsupported-encoding',
      }}
      description="v1 realtime text only supports UTF-8 and UTF-8 with BOM. Files with other encodings stay metadata-only with a stable label."
    />
  );
}

// Copying the path works on every platform; handing the file to the OS needs
// the Electron bridge AND the file's machine to be this one. Storybook has no
// bridge, so the story passes the same callbacks by hand.
function FileErrorActionsStory({
  openTarget,
}: {
  readonly openTarget?: 'browser' | 'default-app';
}) {
  return (
    <div className="w-[420px] rounded-md border border-border bg-background p-4">
      <SessionFileErrorState
        message="Text too large"
        reason="text-too-large"
        fileActions={{
          onCopyPath: fn(),
          ...(openTarget
            ? {
                localHost: {
                  openTarget,
                  revealLabel: 'Show in Finder',
                  onOpen: fn(),
                  onReveal: fn(),
                },
              }
            : {}),
        }}
      />
    </div>
  );
}

const meta = {
  title: 'Sessions/CodeCollabFileStates',
  component: FileTreeStateMatrixStory,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof FileTreeStateMatrixStory>;

export default meta;

export const FileTreeStateMatrix: StoryObj<typeof FileTreeStateMatrixStory> = {
  parameters: {
    docs: {
      description: {
        story:
          'Long file tree variant with 19 mixed entries. Keyboard: Tab into the tree, ArrowUp/ArrowDown to traverse, ArrowRight/ArrowLeft to expand and collapse directories, Enter to activate a row. Focus rings remain visible on every treeitem and on the per-file status strips on the right.',
      },
    },
  },
  render: () => (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <FileTreeStateMatrixStory />
    </div>
  ),
};

export const TextBufferTooLarge: StoryObj<typeof TextBufferTooLargeStory> = {
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        story:
          'Verifies the read-only fallback when a 12 MiB text file would exceed the 10 MiB realtime buffer limit. Keyboard: the status strip is non-interactive and the file viewer area renders a static repair message; Tab should skip past it without trapping focus.',
      },
    },
  },
  render: () => <TextBufferTooLargeStory />,
};

export const BlobUploadTooLarge: StoryObj<typeof BlobUploadTooLargeStory> = {
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        story:
          'Demonstrates a 130 MiB asset rejected by the 100 MiB blob upload cap. Keyboard: no focusable controls inside the strip or the body; the surrounding session UI keeps its normal Tab order.',
      },
    },
  },
  render: () => <BlobUploadTooLargeStory />,
};

export const LineTooLong: StoryObj<typeof LineTooLongStory> = {
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        story:
          'Shows a 4.2 MB minified bundle whose single line breaches the 1 MiB / 200,000 UTF-16 code unit limit. Keyboard navigation is unaffected; the unavailable label is read out via the strip text.',
      },
    },
  },
  render: () => <LineTooLongStory />,
};

export const UnsupportedEncoding: StoryObj<typeof UnsupportedEncodingStory> = {
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        story:
          'A Latin-1 fixture that v1 keeps as metadata-only. Confirms the stable label/repair-hint copy. No interactive controls; Tab order is unchanged.',
      },
    },
  },
  render: () => <UnsupportedEncodingStory />,
};

export const TooLargeWithLocalHostActions: StoryObj<typeof FileErrorActionsStory> = {
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        story:
          'A too-large file on this machine, in the desktop app: the card keeps its explanation and adds every way to read it anyway. Keyboard: all three buttons are in Tab order, Enter/Space activate them.',
      },
    },
  },
  render: () => <FileErrorActionsStory openTarget="default-app" />,
};

export const TooLargeHtmlWithLocalHostActions: StoryObj<typeof FileErrorActionsStory> = {
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        story:
          'The same card for an HTML file, where the OS default handler really is a browser and the button says so.',
      },
    },
  },
  render: () => <FileErrorActionsStory openTarget="browser" />,
};

export const TooLargeOnAnotherMachine: StoryObj<typeof FileErrorActionsStory> = {
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        story:
          'The same file in a browser tab, or on a session whose machine is not this one. Nothing here can open it, so the card offers the path and says nothing it cannot do.',
      },
    },
  },
  render: () => <FileErrorActionsStory />,
};
