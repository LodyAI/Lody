import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import { SessionMonacoTextViewer } from '@/components/sessions/session-monaco-text-viewer';
import { useResolvedTheme } from '@/theme-provider';
import { ChevronLeft } from 'lucide-react';
import {
  MobileProjectFileBrowser,
  type MobileProjectFileBrowserHandle,
} from '@/components/files/mobile-project-file-browser';
import {
  createFakeFileWorkspaceProvider,
  type FileWorkspaceProvider,
  type FileWorkspaceProviderEntry,
  type FileWorkspaceSnapshot,
} from '@/lib/file-workspace-provider';
const fileBrowserStory = stylex.create({
  device: {
    position: 'relative',
    marginInline: 'auto',
    height: 680,
    width: 390,
    overflow: 'hidden',
    borderWidth:"1px",borderStyle:"solid",borderColor:"hsl(var(--border) / 1)",
    backgroundColor: 'hsl(var(--background) / 1)',
    '--mobile-tabbar-height': '0px',
  },
  header: {
    position: 'absolute',
    insetInline: 0,
    top: 0,
    zIndex: 30,
    display: 'flex',
    alignItems: 'center',
    borderBottomWidth:"1px",borderBottomStyle:"solid",borderBottomColor:"color-mix(in oklab,hsl(var(--border) / 1) 50%,transparent)",
    backgroundColor: 'color-mix(in oklab,hsl(var(--background) / 1) 90%,transparent)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    backdropFilter: 'blur(var(--blur-sm))',
  },
  back: {
    display: 'flex',
    height: 'calc(var(--spacing) * 8)',
    width: 'calc(var(--spacing) * 8)',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'calc(infinity * 1px)',
    backgroundColor: 'hsl(var(--card) / 1)',
    color: 'hsl(var(--foreground) / 1)',
    scale: { default: null, ':active': '.95' },
  },
  footer: {
    position: 'absolute',
    insetInline: 0,
    bottom: 0,
    zIndex: 40,
    borderTopWidth:"1px",borderTopStyle:"solid",borderTopColor:"hsl(var(--border) / 1)",
    backgroundColor: 'hsl(var(--card) / 1)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
  },
});
const storyLayoutStyles = stylex.create({
  frame: {
    height: 'calc(var(--spacing) * 5)',
    width: 'calc(var(--spacing) * 5)',
  },
});

const storyLayout = stylex.create({
  label: {
    flex: '1',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'text-align': 'center',
    'font-size': '0.98rem',
    'font-weight': 'var(--font-weight-semibold)',
  },
  frame: {
    width: 'calc(var(--spacing) * 8)',
  },
  overlay: {
    position: 'absolute',
    'inset-inline': 'calc(var(--spacing) * 0)',
    top: '3.25rem',
    bottom: 'calc(var(--spacing) * 0)',
  },
});

// Thin wrapper around the production mobile file browser. Exercises the
// drill-down stack (folder push, file preview) with a fake provider so
// the iOS-style rows, slide animation, and content preview can be QA'd
// without a live Code Collab / RPC backend.

const file = (path: string): FileWorkspaceProviderEntry => ({
  path,
  kind: 'text',
  sourceState: 'live-collaborative',
});

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// A 1x1 red PNG: exercises the raster (binary bytes) image preview path.
const RED_DOT_PNG = bytesFromBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
);

// SVG is XML text, so it travels as a text snapshot but renders as an image.
const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
  <rect width="120" height="120" rx="16" fill="#6366f1" />
  <circle cx="60" cy="60" r="34" fill="#fbbf24" />
</svg>`;

const repoFiles: FileWorkspaceProviderEntry[] = [
  '.agents/config.json',
  '.claude/settings.json',
  '.codex/config.toml',
  '.gemini/config.yaml',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  '.opencode/config.json',
  '.vscode/settings.json',
  'apps/cli/src/index.ts',
  'apps/cli/src/lib/message-handler.ts',
  'apps/web/src/main.tsx',
  'assets/logo.svg',
  'assets/photo-too-large.png',
  'assets/red-dot.png',
  'backend/convex/schema.ts',
  'docs/README.md',
  'docs/local-project-file-browsing.md',
  'functions/index.ts',
  'locales/en.json',
  'locales/zh_CN.json',
  'package.json',
  'pnpm-workspace.yaml',
  'README.md',
  'preview.html',
].map(file);

const snapshots: Record<string, FileWorkspaceSnapshot> = {
  'preview.html': {
    kind: 'text',
    text: `<style>body { font: 18px system-ui; padding: 20px; background: #fff; color: #222; } h1 { color: #246; }</style>
      <h1>Mobile HTML report</h1><p>Preview opens immediately.</p>
      <a href="https://example.invalid/escape">External link</a>
      <button onclick="this.textContent='Script ran'">Run script</button>
      <script>document.body.dataset.executed = 'yes';</script>`,
  },
  'README.md': {
    kind: 'text',
    text: '# lody\n\nA collaborative coding workspace.\n\n- apps/cli\n- apps/web\n- packages/components\n',
  },
  'package.json': {
    kind: 'text',
    text: '{\n  "name": "lody",\n  "private": true,\n  "workspaces": ["apps/*", "packages/*"]\n}\n',
  },
  'docs/README.md': {
    kind: 'text',
    text: '# Docs\n\n`docs/` contains non-normative guides and operational notes.\n',
  },
  // Raster image: rendered from raw bytes.
  'assets/red-dot.png': { kind: 'binary', bytes: RED_DOT_PNG },
  // SVG: text snapshot, rendered as an image.
  'assets/logo.svg': { kind: 'text', text: SAMPLE_SVG },
  // Image that exceeded the transfer cap — binary snapshot with no bytes, so
  // the browser shows a "too large to preview" notice.
  'assets/photo-too-large.png': { kind: 'binary' },
};

/* Mirrors how `MobileProjectScreen` drives the browser in production:
   one shared header that renders the breadcrumb from `onPathChange` and
   pops levels through the imperative handle. Lets the story exercise the
   full drill-in / back flow (edge-swipe-back is native-only). */
function FileBrowserHarness({
  provider,
  message,
  projectName,
  /* Stands in for `session-detail.tsx`'s mobile Files drawer, which owns a
     viewer and takes over `onOpenFile` instead of letting the browser
     preview in place. */
  onOpenFile,
  openedPath,
  height,
}: {
  provider: FileWorkspaceProvider | null;
  message?: string;
  projectName: string;
  onOpenFile?: (path: string) => void;
  openedPath?: string | null;
  height?: number;
}) {
  const ref = useRef<MobileProjectFileBrowserHandle>(null);
  return (
    <div
      data-file-browser-harness
      style={height === undefined ? undefined : { height }}
      {...stylex.props(fileBrowserStory.device)}
    >
      {/* Stand-in for the production project header. The breadcrumb lives
          inside the browser body, so the harness header is just back +
          project name. */}
      <div {...stylex.props(fileBrowserStory.header)}>
        <button
          type="button"
          onClick={() => ref.current?.goBack()}
          {...stylex.props(fileBrowserStory.back)}
          aria-label="Back"
        >
          <ChevronLeft {...stylex.props(storyLayoutStyles.frame)} />
        </button>
        <span {...stylex.props(storyLayout.label)}>{projectName}</span>
        <span {...stylex.props(storyLayout.frame)} />
      </div>
      <div {...stylex.props(storyLayout.overlay)}>
        <MobileProjectFileBrowser
          ref={ref}
          provider={provider}
          message={message}
          {...(onOpenFile ? { onOpenFile } : {})}
        />
      </div>
      {/* The host's viewer, stubbed: in production this is the session's
          file viewer tab. */}
      {openedPath ? (
        <div {...stylex.props(fileBrowserStory.footer)}>opened in host viewer: {openedPath}</div>
      ) : null}
    </div>
  );
}

const meta = {
  title: 'Files/MobileProjectFileBrowser',
  component: MobileProjectFileBrowser,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof MobileProjectFileBrowser>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { provider: createFakeFileWorkspaceProvider({ files: repoFiles, snapshots }) },
  render: (args) => (
    <FileBrowserHarness provider={args.provider} message={args.message} projectName="lody" />
  ),
};

export const EmptyProject: Story = {
  args: { provider: createFakeFileWorkspaceProvider({ files: [] }) },
  render: (args) => (
    <FileBrowserHarness
      provider={args.provider}
      message={args.message}
      projectName="empty-project"
    />
  ),
};

/* The mobile session Files drawer: the host owns the file viewer, so tapping a
   file reports the path out and the browser stays on its directory level
   instead of pushing a preview. */
export const DelegatedFileOpen: Story = {
  args: { provider: createFakeFileWorkspaceProvider({ files: repoFiles, snapshots }) },
  render: function DelegatedFileOpenStory(args) {
    const [openedPath, setOpenedPath] = useState<string | null>(null);
    return (
      <FileBrowserHarness
        provider={args.provider}
        message={args.message}
        projectName="lody"
        onOpenFile={setOpenedPath}
        openedPath={openedPath}
      />
    );
  },
};

export const Unavailable: Story = {
  args: { provider: null, message: 'Files are unavailable.' },
  render: (args) => (
    <FileBrowserHarness provider={args.provider} message={args.message} projectName="lody" />
  ),
};

export const HtmlSourceHeightBoundary: Story = {
  args: { provider: createFakeFileWorkspaceProvider({ files: repoFiles, snapshots }) },
  render: (args) => <FileBrowserHarness provider={args.provider} projectName="lody" height={220} />,
};

const monacoCallerStyles = stylex.create({
  frame: { width: 320, height: 320 },
  height: { height: 128 },
  width: { width: 180 },
  overflow: { overflow: 'visible' },
  minHeight: { minHeight: 480 },
});

function MonacoCallerFixture({
  contract = 'default',
}: {
  contract?: 'default' | 'height' | 'width' | 'overflow' | 'minHeight';
}) {
  const theme = useResolvedTheme();
  return (
    <div data-monaco-caller-fixture={contract} {...stylex.props(monacoCallerStyles.frame)}>
      <SessionMonacoTextViewer
        text={'const answer = 42;\n// actual Monaco layout caller contract\n'}
        language="typescript"
        resolvedTheme={theme}
        className={
          contract === 'default' ? undefined : stylex.props(monacoCallerStyles[contract]).className
        }
      />
    </div>
  );
}

export const MonacoDefaultCaller: Story = {
  args: { provider: null },
  render: () => <MonacoCallerFixture />,
};
export const MonacoHeightCaller: Story = {
  args: { provider: null },
  render: () => <MonacoCallerFixture contract="height" />,
};
export const MonacoWidthCaller: Story = {
  args: { provider: null },
  render: () => <MonacoCallerFixture contract="width" />,
};
export const MonacoOverflowCaller: Story = {
  args: { provider: null },
  render: () => <MonacoCallerFixture contract="overflow" />,
};

export const MonacoMinHeightCaller: Story = {
  args: { provider: null },
  render: () => <MonacoCallerFixture contract="minHeight" />,
};
