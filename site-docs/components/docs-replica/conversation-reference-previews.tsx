import { ChevronRight, Copy, Folder, PanelRight, Plus, X } from 'lucide-react';
import { ReplicaBrowserToolbar } from '../landing-replica/browser-toolbar';
import { Button } from '../landing-replica/button';
import { ReplicaDiffViewer } from '../landing-replica/changes';
import { ReplicaSendButton } from '../landing-replica/composer';
import {
  ReplicaPermissionModeTrigger,
  ReplicaRunConfigTrigger,
} from '../landing-replica/composer-controls';
import { AgentIcon, FileIcon } from '../landing-replica/icons';
import type { ReplicaChangeFile, ReplicaLocale } from '../landing-replica/types';
import { cn } from '../landing-replica/utils';

/* Display-only docs previews for the conversation reference pages. They copy
   the current app's markup and tokens (`assistant-edited-files.tsx`,
   `ui/diff-viewer/diff-viewer.tsx`, `sessions/session-changes-sidebar.tsx`,
   `sessions/components/file-tree-view.tsx`, `chat/chat-composer.tsx`,
   `ai-gui/view.tsx`, and `sessions/session-browser-panel.tsx`) but never import
   the app. Images are inline SVG data URIs so no screenshot or binary asset
   ships from this module. */

const svgDataUri = (markup: string): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(markup)}`;

const ATTACHMENT_PREVIEW_IMAGE = svgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320" fill="none">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="320" y2="320" gradientUnits="userSpaceOnUse">
      <stop stop-color="#111b31" />
      <stop offset="1" stop-color="#050912" />
    </linearGradient>
  </defs>
  <rect width="320" height="320" rx="36" fill="url(#bg)" />
  <rect x="30" y="48" width="260" height="56" rx="14" fill="#1a2742" stroke="#2b3c5f" />
  <text x="48" y="82" fill="#9db2d3" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18">Configuration Type</text>
  <rect x="30" y="118" width="260" height="48" rx="14" fill="#1b2740" stroke="#31486f" />
  <text x="48" y="148" fill="#dbeafe" font-family="ui-sans-serif, system-ui, sans-serif" font-size="20">Claude</text>
  <text x="268" y="149" fill="#93c5fd" font-family="ui-sans-serif, system-ui, sans-serif" font-size="17" text-anchor="end">⌄</text>
  <rect x="30" y="180" width="260" height="92" rx="14" fill="#121d33" stroke="#2b3c5f" />
  <rect x="38" y="188" width="244" height="34" rx="10" fill="#223354" />
  <text x="52" y="210" fill="#eff6ff" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18">Claude</text>
  <text x="272" y="211" fill="#93c5fd" font-family="ui-sans-serif, system-ui, sans-serif" font-size="16" text-anchor="end">✓</text>
  <text x="52" y="252" fill="#c7d2fe" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18">Codex</text>
</svg>
`);

const GENERATED_PREVIEW_IMAGE = svgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" width="420" height="560" viewBox="0 0 420 560" fill="none">
  <defs>
    <radialGradient id="water" cx="50%" cy="28%" r="82%">
      <stop stop-color="#0b2b52" />
      <stop offset="1" stop-color="#020713" />
    </radialGradient>
    <linearGradient id="bell" x1="88" y1="122" x2="334" y2="318" gradientUnits="userSpaceOnUse">
      <stop stop-color="#a5d8ff" stop-opacity="0.82" />
      <stop offset="1" stop-color="#5b8cc7" stop-opacity="0.32" />
    </linearGradient>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="16" />
    </filter>
  </defs>
  <rect width="420" height="560" fill="url(#water)" />
  <circle cx="210" cy="184" r="132" fill="#4f9cf9" opacity="0.18" filter="url(#glow)" />
  <path d="M94 204c0-82 52-132 116-132s116 50 116 132c0 38-28 65-64 65H158c-36 0-64-27-64-65Z" fill="url(#bell)" stroke="#c7e4ff" stroke-opacity="0.55" stroke-width="2" />
  <path d="M124 224c18 35 42 54 86 54s68-19 86-54" fill="none" stroke="#dbeafe" stroke-opacity="0.42" stroke-width="2" />
  <path d="M151 264c-15 54-24 105-16 172" fill="none" stroke="#8ec5ff" stroke-opacity="0.55" stroke-width="3" stroke-linecap="round" />
  <path d="M179 274c-8 58-13 112-8 180" fill="none" stroke="#a9d5ff" stroke-opacity="0.5" stroke-width="3" stroke-linecap="round" />
  <path d="M210 278v182" fill="none" stroke="#dbeafe" stroke-opacity="0.48" stroke-width="3" stroke-linecap="round" />
  <path d="M241 274c8 58 13 112 8 180" fill="none" stroke="#a9d5ff" stroke-opacity="0.5" stroke-width="3" stroke-linecap="round" />
  <path d="M269 264c15 54 24 105 16 172" fill="none" stroke="#8ec5ff" stroke-opacity="0.55" stroke-width="3" stroke-linecap="round" />
  <g fill="#dbeafe" opacity="0.7">
    <circle cx="162" cy="220" r="5" />
    <circle cx="188" cy="232" r="4" />
    <circle cx="232" cy="232" r="4" />
    <circle cx="258" cy="220" r="5" />
  </g>
</svg>
`);

type SummaryFile = {
  filePath: string;
  add: number;
  del: number;
};

const FILE_SUMMARY_COPY: Record<
  ReplicaLocale,
  { summary: (count: number) => string; changed: string }
> = {
  en: {
    summary: (count) => `Edited ${count} files`,
    changed: 'Changed',
  },
  zh: {
    summary: (count) => `编辑了 ${count} 个文件`,
    changed: '已更改',
  },
};

const CONVERSATION_DIFF_COPY: Record<ReplicaLocale, { finished: string; assistantText: string }> = {
  en: {
    finished: 'Finished working',
    assistantText:
      'Implemented the requested changes and ran the test suite. The landing composer now keeps attached images while switching models.',
  },
  zh: {
    finished: '已完成工作',
    assistantText: '已完成修改并运行了测试。切换模型时，首页输入框会保留已附加的图片。',
  },
};

const CONVERSATION_DIFF_FILES: readonly SummaryFile[] = [
  {
    filePath: 'packages/components/src/components/chat/chat-landing-view.tsx',
    add: 5,
    del: 0,
  },
  {
    filePath: 'packages/components/src/components/chat/chat-landing.tsx',
    add: 16,
    del: 0,
  },
  {
    filePath: 'packages/components/src/components/chat/local-project-chat-landing.tsx',
    add: 16,
    del: 0,
  },
  {
    filePath: 'packages/shared/src/agent-config-setting.ts',
    add: 1,
    del: 215,
  },
];

function splitFilePath(filePath: string): { directory: string; name: string } {
  const normalized = filePath.replace(/\\/g, '/');
  const separatorIndex = normalized.lastIndexOf('/');
  if (separatorIndex === -1) return { directory: '', name: normalized };
  return {
    directory: normalized.slice(0, separatorIndex),
    name: normalized.slice(separatorIndex + 1),
  };
}

function SummaryStats({ add, del, locale }: { add: number; del: number; locale: ReplicaLocale }) {
  const copy = FILE_SUMMARY_COPY[locale];
  if (add === 0 && del === 0) {
    return (
      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{copy.changed}</span>
    );
  }

  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
      <span className="text-code-added">+{add}</span>
      <span className="text-code-removed">-{del}</span>
    </span>
  );
}

function AssistantEditedFilesSummary({
  files,
  locale,
}: {
  files: readonly SummaryFile[];
  locale: ReplicaLocale;
}) {
  const copy = FILE_SUMMARY_COPY[locale];
  const totals = files.reduce(
    (result, file) => ({ add: result.add + file.add, del: result.del + file.del }),
    { add: 0, del: 0 }
  );
  const isSingleFile = files.length === 1;

  return (
    <div className="w-full text-left">
      <div className="overflow-hidden rounded-xl border border-border bg-background">
        {!isSingleFile ? (
          <div className="flex min-h-8 items-center gap-3 bg-muted/30 px-2.5 py-1.5">
            <span className="min-w-0 flex-1 text-xs font-medium text-foreground/80">
              {copy.summary(files.length)}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
              <span className="text-code-added">+{totals.add}</span>
              <span className="text-code-removed">-{totals.del}</span>
            </span>
          </div>
        ) : null}
        <div
          className={cn('divide-y divide-border/70', !isSingleFile && 'border-t border-border/70')}
        >
          {files.map((file) => {
            const { directory, name } = splitFilePath(file.filePath);
            return (
              <div
                key={file.filePath}
                className={cn(
                  'flex w-full min-w-0 items-center gap-2 px-2.5 text-left',
                  isSingleFile ? 'min-h-10 py-2' : 'min-h-9 py-1.5'
                )}
                title={file.filePath}
              >
                <span className="min-w-0 flex-1 truncate text-sm leading-6">
                  <span className="text-foreground/90">{name}</span>
                  {directory ? (
                    <span className="ml-1.5 text-muted-foreground/70">{directory}</span>
                  ) : null}
                </span>
                <SummaryStats add={file.add} del={file.del} locale={locale} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function ConversationDiffPreview({ locale = 'en' }: { locale?: ReplicaLocale }) {
  const copy = CONVERSATION_DIFF_COPY[locale];

  return (
    <div className="my-6">
      <div
        aria-hidden="true"
        className="lody-app-preview overflow-hidden rounded-xl border border-border bg-background p-4 text-foreground shadow-sm sm:p-5"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted/50">
            <AgentIcon agent="codex" className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span className="font-medium">{copy.finished}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">11m 19s</span>
            </div>
            <div className="max-w-[760px] rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-3 text-sm leading-6 text-card-foreground shadow-sm">
              {copy.assistantText}
            </div>
            <div className="mt-2.5 max-w-[760px]">
              <AssistantEditedFilesSummary files={CONVERSATION_DIFF_FILES} locale={locale} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Source: packages/components/src/ui/diff-viewer/diff-viewer.tsx and
   DiffViewer.stories.tsx. The landing replica already carries the production
   card chrome and Pierre theme wiring, so the docs preview only supplies a
   synthetic file. Two hidden variants follow the reader's light/dark theme:
   @pierre/diffs needs an explicit theme type, which cannot be read from CSS. */
const DIFF_PREVIEW_FILE: ReplicaChangeFile = {
  path: 'apps/cli/src/lib/local-probe.ts',
  add: 2,
  del: 1,
  oldText: [
    "import * as http from 'http';",
    "import * as os from 'os';",
    "import type { MachineId } from './ids';",
    "import { LOCAL_PROBE_PORT } from './local-probe';",
    "import type { Logger } from './logger';",
    '',
    'const ALLOWED_ORIGINS = new Set([',
    "  'https://lody.ai',",
    ']);',
    '',
  ].join('\n'),
  newText: [
    "import * as http from 'http';",
    "import * as os from 'os';",
    "import type { MachineId } from './ids';",
    "import { LOCAL_PROBE_PORT } from './local-probe';",
    "import type { Logger } from './logger';",
    '',
    'const ALLOWED_ORIGINS = new Set([',
    "  'https://lody.ai',",
    "  'https://app.lody.ai',",
    ']);',
    '',
  ].join('\n'),
};

export function DiffViewerPreview({ locale = 'en' }: { locale?: ReplicaLocale }) {
  return (
    <div className="my-6">
      <div
        aria-hidden="true"
        className="lody-app-preview overflow-hidden rounded-xl border border-border bg-background p-3 text-foreground shadow-sm sm:p-4"
      >
        <span className="sr-only">
          {locale === 'zh' ? '差异查看器预览' : 'Diff viewer preview'}
        </span>
        <div className="hidden dark:block">
          <ReplicaDiffViewer file={DIFF_PREVIEW_FILE} dark />
        </div>
        <div className="dark:hidden">
          <ReplicaDiffViewer file={DIFF_PREVIEW_FILE} dark={false} />
        </div>
      </div>
    </div>
  );
}

type FolderTreeEntry = {
  name: string;
  kind: 'folder';
};

type FileTreeEntry = {
  name: string;
  kind: 'file';
  modified?: boolean;
};

type TreeEntry = FolderTreeEntry | FileTreeEntry;

const SESSION_TREE_COPY: Record<
  ReplicaLocale,
  { files: string; changes: string; modified: string }
> = {
  en: { files: 'Files', changes: 'Changes', modified: 'Modified in this conversation' },
  zh: { files: '文件', changes: '变更', modified: '当前对话中已修改' },
};

// Short synthetic root from the SessionChangesSidebar / FileTreeList stories.
// All folders stay collapsed; this is a display-only still, not a tree control.
const SESSION_TREE_ENTRIES: readonly TreeEntry[] = [
  { name: 'apps', kind: 'folder' },
  { name: 'backend', kind: 'folder' },
  { name: 'docs', kind: 'folder' },
  { name: 'functions', kind: 'folder' },
  { name: 'locales', kind: 'folder' },
  { name: 'packages', kind: 'folder' },
  { name: 'scripts', kind: 'folder' },
  { name: 'specs', kind: 'folder' },
  { name: 'AGENTS.md', kind: 'file', modified: true },
  { name: 'CHANGELOG.md', kind: 'file', modified: true },
  { name: 'CLAUDE.md', kind: 'file' },
  { name: 'conductor.json', kind: 'file' },
  { name: 'DEV.md', kind: 'file', modified: true },
  { name: 'package.json', kind: 'file' },
  { name: 'pnpm-lock.yaml', kind: 'file' },
  { name: 'pnpm-workspace.yaml', kind: 'file' },
  { name: 'README.md', kind: 'file', modified: true },
  { name: 'release-please-config.json', kind: 'file' },
];

function FolderTreeRow({ name }: { name: string }) {
  return (
    <div
      role="treeitem"
      aria-expanded={false}
      className="flex h-[22px] items-center gap-1.5 rounded-md px-2 text-[13px] text-foreground/90"
    >
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
      <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate">{name}</span>
    </div>
  );
}

function FileTreeRow({ entry, locale }: { entry: FileTreeEntry; locale: ReplicaLocale }) {
  const copy = SESSION_TREE_COPY[locale];
  return (
    <div
      role="treeitem"
      title={entry.modified ? copy.modified : entry.name}
      className="flex h-[22px] items-center gap-1.5 rounded-md px-2 text-[13px] text-foreground/90"
    >
      <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <FileIcon path={entry.name} className="h-4 w-4" />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {entry.modified ? (
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-primary">
          M±
        </span>
      ) : null}
    </div>
  );
}

export function SessionFilesPreview({ locale = 'en' }: { locale?: ReplicaLocale }) {
  const copy = SESSION_TREE_COPY[locale];

  return (
    <div className="my-6">
      <div
        aria-hidden="true"
        className="lody-app-preview mx-auto w-full max-w-[320px] overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-sm"
      >
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
          <div className="inline-flex h-6 items-center rounded-md border border-border/60 bg-muted/40 p-0.5 text-[11px]">
            <span className="flex h-5 items-center rounded px-2 font-medium text-foreground shadow-sm">
              {copy.files}
            </span>
            <span className="flex h-5 items-center rounded px-2 text-muted-foreground">
              {copy.changes}
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={locale === 'zh' ? '收起侧边栏' : 'Collapse sidebar'}
            className="ml-auto h-6 w-6 text-muted-foreground"
          >
            <PanelRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div role="tree" className="p-1.5">
          <div className="flex flex-col gap-px">
            {SESSION_TREE_ENTRIES.map((entry) =>
              entry.kind === 'folder' ? (
                <FolderTreeRow key={entry.name} name={entry.name} />
              ) : (
                <FileTreeRow key={entry.name} entry={entry} locale={locale} />
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const IMAGE_INPUT_COPY: Record<
  ReplicaLocale,
  {
    attachmentAlt: string;
    removeImage: string;
    addAttachment: string;
    permission: string;
    prompt: string;
  }
> = {
  en: {
    attachmentAlt: 'Synthetic screenshot of a Configuration Type dropdown',
    removeImage: 'Remove image',
    addAttachment: 'Add attachment',
    permission: 'Agent (full access)',
    prompt: "What's in this image?",
  },
  zh: {
    attachmentAlt: '配置类型下拉框的模拟截图',
    removeImage: '移除图片',
    addAttachment: '添加附件',
    permission: 'Agent（完全访问）',
    prompt: '图片里是什么？',
  },
};

const COMPOSER_BOX_CLASS =
  '@container/composer-box flex flex-col gap-1 rounded-xl border px-2 py-1.5 transition-colors duration-150 border-foreground/[0.10] bg-[hsl(var(--composer))] shadow-[0_3px_6px_-2px_lch(0%_0_0/0.02),0_1px_1px_lch(0%_0_0/0.04)] dark:shadow-none dark:border-input-border/70 dark:bg-input/90 [--mention-chip-surface:hsl(var(--composer))]';

export function ImageInputPreview({ locale = 'en' }: { locale?: ReplicaLocale }) {
  const copy = IMAGE_INPUT_COPY[locale];

  return (
    <div className="my-6 flex justify-center">
      <div
        aria-hidden="true"
        className="lody-app-preview [--composer:var(--muted)] w-full max-w-[560px] text-foreground"
      >
        <div className={COMPOSER_BOX_CLASS}>
          <div className="input-scrollbar flex gap-2 overflow-x-auto pb-1">
            <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-border">
              <img
                src={ATTACHMENT_PREVIEW_IMAGE}
                alt={copy.attachmentAlt}
                className="h-full w-full object-cover"
              />
              <Button
                type="button"
                variant="secondary"
                size="icon"
                aria-label={copy.removeImage}
                className="absolute right-1 top-1 h-5 w-5 min-w-0 rounded-md p-0 text-foreground shadow-sm"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
          <div className="min-h-12 px-1 pt-1 text-sm leading-6 text-input-foreground">
            {copy.prompt}
          </div>
          <div className="flex items-center gap-1 pt-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={copy.addAttachment}
              className="h-7 w-7 shrink-0 text-muted-foreground"
            >
              <Plus className="h-4 w-4" strokeWidth={1.5} />
            </Button>
            <div className="@container/composer-face flex min-w-0 flex-1 flex-nowrap items-center gap-x-1.5 overflow-hidden">
              <ReplicaRunConfigTrigger agent="codex" modelLabel="5.4" thinkLabel="Medium" />
              <ReplicaPermissionModeTrigger label={copy.permission} />
            </div>
            <ReplicaSendButton variant="session" disabled={false} />
          </div>
        </div>
      </div>
    </div>
  );
}

const IMAGE_OUTPUT_COPY: Record<
  ReplicaLocale,
  { alt: string; metadata: string; duration: string }
> = {
  en: {
    alt: 'Synthetic generated jellyfish image',
    metadata: 'Generated with gpt-5.4',
    duration: '21m 14s',
  },
  zh: {
    alt: '模拟生成的水母图片',
    metadata: '由 gpt-5.4 生成',
    duration: '21m 14s',
  },
};

export function ImageOutputPreview({ locale = 'en' }: { locale?: ReplicaLocale }) {
  const copy = IMAGE_OUTPUT_COPY[locale];

  return (
    <div className="my-6">
      <div
        aria-hidden="true"
        className="lody-app-preview overflow-hidden rounded-xl border border-border bg-background p-4 text-foreground shadow-sm sm:p-5"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted/50">
            <AgentIcon agent="codex" className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span className="tabular-nums">2026/5/6 12:55</span>
              <span aria-hidden="true">·</span>
              <span>{copy.metadata}</span>
            </div>
            <div className="inline-flex max-w-full flex-col overflow-hidden rounded-xl border border-border/70 bg-muted/20">
              <div className="inline-flex max-w-full">
                <img
                  src={GENERATED_PREVIEW_IMAGE}
                  alt={copy.alt}
                  width={210}
                  height={280}
                  className="block max-h-[280px] max-w-full object-contain"
                />
              </div>
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="tabular-nums">{copy.duration}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const BROWSER_COPY: Record<
  ReplicaLocale,
  {
    heading: string;
    body: string;
    getStarted: string;
    viewDocs: string;
    commentTitle: string;
    commentTarget: string;
    commentBody: string;
    cancel: string;
    addComment: string;
  }
> = {
  en: {
    heading: 'Run your agents from anywhere',
    body: 'Start work on one machine, then keep it moving from desktop, tablet, or phone.',
    getStarted: 'Get started',
    viewDocs: 'View docs',
    commentTitle: 'Preview comment',
    commentTarget: 'h2 "Run your agents from anywhere"',
    commentBody: 'Tighten the spacing above the primary action.',
    cancel: 'Cancel',
    addComment: 'Add comment',
  },
  zh: {
    heading: '随处运行你的 Agent',
    body: '在一台机器上开始工作，然后在桌面、平板或手机上继续推进。',
    getStarted: '开始使用',
    viewDocs: '查看文档',
    commentTitle: '预览评论',
    commentTarget: 'h2 “随处运行你的 Agent”',
    commentBody: '收紧主操作按钮上方的间距。',
    cancel: '取消',
    addComment: '添加评论',
  },
};

export function BrowserPreview({ locale = 'en' }: { locale?: ReplicaLocale }) {
  const copy = BROWSER_COPY[locale];

  return (
    <div className="my-6">
      <div
        aria-hidden="true"
        className="lody-app-preview overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-sm"
      >
        <ReplicaBrowserToolbar
          address="http://127.0.0.1:5173/dashboard"
          loading={false}
          annotating
          locale={locale}
        />
        <div className="relative min-h-[310px] overflow-hidden bg-[linear-gradient(160deg,#071a2c_0%,#03090f_78%,#02060b_100%)] px-5 py-5 text-slate-100 sm:px-8">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-2 font-semibold tracking-wide">
              <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-sky-400 text-sm text-slate-950">
                L
              </span>
              Lody
            </span>
            <span className="hidden items-center gap-3 text-slate-300/90 sm:flex">
              <span>{copy.viewDocs}</span>
              <span>{copy.getStarted}</span>
            </span>
          </div>
          <div className="mx-auto mt-10 max-w-[360px] text-center">
            <div className="relative inline-block">
              <h2 className="text-balance text-2xl font-bold leading-tight tracking-tight text-white sm:text-3xl">
                {copy.heading}
              </h2>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -inset-2 rounded-md border-2 border-[rgba(37,99,235,0.9)] bg-[rgba(37,99,235,0.08)]"
              />
            </div>
            <p className="mt-4 text-sm leading-6 text-slate-300">{copy.body}</p>
            <div className="mt-5 flex justify-center gap-2">
              <span className="rounded-lg bg-sky-400 px-3.5 py-2 text-xs font-semibold text-slate-950">
                {copy.getStarted}
              </span>
              <span className="rounded-lg border border-slate-500/60 px-3.5 py-2 text-xs font-medium text-slate-200">
                {copy.viewDocs}
              </span>
            </div>
          </div>
          <div className="absolute bottom-4 right-4 z-10 w-[min(240px,calc(100%-2rem))] rounded-xl border border-border bg-popover p-3 text-left text-popover-foreground shadow-2xl">
            <div className="mb-2 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold">{copy.commentTitle}</div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">
                  {copy.commentTarget}
                </div>
              </div>
              <button
                type="button"
                aria-label={copy.cancel}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-hover hover:text-hover-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="rounded-md border border-input-border bg-background px-2.5 py-2 text-xs text-muted-foreground">
              {copy.commentBody}
            </div>
            <div className="mt-2 flex justify-end gap-1.5">
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs">
                {copy.cancel}
              </Button>
              <Button type="button" variant="default" size="sm" className="h-7 px-2 text-xs">
                {copy.addComment}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
