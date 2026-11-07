import * as stylex from '@stylexjs/stylex';
/**
 * Docs-owned, display-only previews for the slash-command and mention reference
 * pages. These replace the static `_docs-assets/slash.png`,
 * `_docs-assets/20260206-mention.png`, and `_docs-assets/mention-issue.png`
 * screenshots:
 *
 * - `SlashCommandsPreview`  → the `/` command popup over a composer.
 * - `MentionPreview`        → the `@` mention menu (file results and the
 *   Issues/Pull Requests category list) and the `$` skill popup over a composer.
 *
 * The markup is copied/inspired from the current app surfaces but this file
 * never imports app runtime code (`@/*`, `@lody/*`, Convex, jotai, i18next, …):
 *
 * - `packages/components/src/components/mentions/mention-two-level-menu.tsx`
 *   (row/list/title/hint shapes, the category rows, and the command, file,
 *   issue/PR and skill candidate rendering)
 * - `packages/components/src/components/mentions/combined-mention-textarea.tsx`
 *   (the two-level menu wiring around the composer textarea)
 * - `packages/components/src/components/mentions/mention-registry.ts`
 *   (`toCommandCandidate`, `toFileCandidate`, `toSkillCandidate`, and the
 *   `useMentionCategories` category list)
 * - `packages/components/src/components/mentions/mention-project-file-source.ts`
 *   (file/folder rows)
 * - `packages/components/src/hooks/use-available-commands.ts` (agent commands)
 * - `packages/components/src/stories/MentionTwoLevelMenu.stories.tsx`
 *   (synthetic candidate fixtures)
 *
 * All data is synthetic and every preview renders completely in prerendered
 * HTML; see `site-docs/AGENTS.md` → "Product replica boundary".
 */

import type { ReactNode } from 'react';
import {
  Boxes,
  ChevronRight,
  CircleDot,
  Folder,
  FolderCode,
  GitPullRequest,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { ReplicaSendButton } from '../landing-replica/composer';
import {
  ReplicaBranchWorktreePill,
  ReplicaPermissionModeTrigger,
  ReplicaProjectSelectorTrigger,
  ReplicaRunConfigTrigger,
} from '../landing-replica/composer-controls';
import { FileIcon } from '../landing-replica/icons';
import type { ReplicaLocale } from '../landing-replica/types';
const previewStyles = stylex.create({
  section: {
    'margin-block': 'calc(var(--spacing) * 6)',
  },
  text: {
    overflow: 'hidden',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--background))',
    padding: 'calc(var(--spacing) * 4)',
    color: 'hsl(var(--foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-sm)',
    '--composer': 'var(--muted)',
    '@media (width >= 40rem)': {
      padding: 'calc(var(--spacing) * 6)',
    },
  },
  frame: {
    'margin-inline': 'auto',
    width: '100%',
    'max-width': 'var(--container-2xl)',
  },
  row: {
    display: 'flex',
    width: '100%',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'var(--spacing)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  stack: {
    'container-type': 'inline-size',
    'container-name': 'composer-box',
    display: 'flex',
    'flex-direction': 'column',
    gap: 'var(--spacing)',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--foreground)) 10%, transparent)',
    'background-color': 'hsl(var(--composer))',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
    'box-shadow':
      '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 3px 6px -2px lch(0% 0 0/0.02), 0 1px 1px lch(0% 0 0/0.04)',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': '150ms',
    '--mention-chip-surface': 'hsl(var(--composer))',
    ':where(.dark, .dark *)': {
      'border-color': 'color-mix(in oklab, hsl(var(--input-border)) 70%, transparent)',
      'background-color': 'color-mix(in oklab, hsl(var(--input)) 90%, transparent)',
      'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000',
    },
  },
  section2: {
    'margin-top': 'var(--spacing)',
  },
  text2: {
    'min-height': 'calc(var(--spacing) * 8)',
    'padding-inline': 'var(--spacing)',
    'padding-top': 'var(--spacing)',
    'font-size': 'var(--text-sm)',
    'line-height': 'calc(var(--spacing) * 6)',
    color: 'hsl(var(--input-foreground))',
  },
  frame2: {
    'margin-left': '1px',
    display: 'inline-block',
    height: 'calc(var(--spacing) * 4)',
    width: '1.5px',
    translate: '0 calc(var(--spacing) * 0.5)',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'color-mix(in oklab, hsl(var(--foreground)) 70%, transparent)',
  },
  row2: {
    display: 'flex',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'padding-top': 'calc(var(--spacing) * 0.5)',
  },
  row3: {
    'container-type': 'inline-size',
    'container-name': 'composer-face',
    display: 'flex',
    'min-width': '0px',
    flex: '1',
    'flex-wrap': 'nowrap',
    'align-items': 'center',
    'column-gap': 'calc(var(--spacing) * 1.5)',
    overflow: 'hidden',
  },
  text3: {
    'margin-top': 'calc(var(--spacing) * 2)',
    'text-align': 'center',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground))',
  },
  section3: {
    position: 'relative',
    'margin-top': 'var(--spacing)',
    overflow: 'hidden',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--popover))',
    'padding-block': 'var(--spacing)',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-lg)',
  },
  overlay: {
    'pointer-events': 'none',
    position: 'absolute',
    top: 'calc(var(--spacing) * 2)',
    right: 'var(--spacing)',
    height: 'calc(1 / 3 * 100%)',
    width: 'var(--spacing)',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'color-mix(in oklab, hsl(var(--foreground)) 15%, transparent)',
  },
  text4: {
    color: 'color-mix(in oklab, hsl(var(--foreground)) 90%, transparent)',
  },
  text5: {
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 80%, transparent)',
  },
  text6: {
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--primary))',
  },
  stack2: {
    'margin-inline': 'var(--spacing)',
    display: 'flex',
    'flex-direction': 'column',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
  },
  section4: {
    'background-color': 'hsl(var(--selection))',
  },
  text7: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'calc(var(--spacing) * 6)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--foreground))',
  },
  text8: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': '13px',
    'line-height': 'calc(var(--spacing) * 5)',
    color: 'hsl(var(--muted-foreground))',
  },
  text9: {
    color: 'hsl(var(--foreground))',
  },
  row4: {
    'margin-inline': 'var(--spacing)',
    display: 'flex',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'var(--spacing)',
  },
  row5: {
    display: 'flex',
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    color: 'hsl(var(--muted-foreground))',
  },
  text10: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    color: 'hsl(var(--status-warning))',
  },
  frame3: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
  },
  text11: {
    'min-width': '0px',
    flex: '1',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'calc(var(--spacing) * 6)',
  },
  row6: {
    'margin-inline': 'var(--spacing)',
    display: 'flex',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
  },
  text12: {
    'min-width': '0px',
    flex: '1',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'calc(var(--spacing) * 6)',
    color: 'hsl(var(--foreground))',
  },
  text13: {
    'flex-shrink': '0',
    'font-family': 'var(--font-mono)',
    'font-size': '11px',
    'line-height': '1',
    color: 'hsl(var(--muted-foreground))',
  },
  text14: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    'flex-shrink': '0',
    color: 'hsl(var(--muted-foreground))',
  },
  text15: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    color: 'hsl(var(--primary))',
  },
  text16: {
    'flex-shrink': '0',
    'font-size': '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  text17: {
    'border-radius': '3px',
    'background-color': 'color-mix(in oklab, hsl(var(--primary)) 15%, transparent)',
    'padding-inline': '1px',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--foreground))',
  },
  text18: {
    'border-radius': '3px',
    'background-color': 'color-mix(in oklab, hsl(var(--primary)) 15%, transparent)',
    'padding-inline': '1px',
    color: 'hsl(var(--foreground))',
  },
});

// ---------------------------------------------------------------------------
// Shared composer shell
// ---------------------------------------------------------------------------

/** `ChatComposer`'s outer box, copied from the landing replica. */

const PERMISSION_COPY: Record<ReplicaLocale, string> = {
  en: 'Agent (full access)',
  zh: 'Agent（完全访问）',
};

type ComposerPreviewProps = {
  locale: ReplicaLocale;
  caption: string;
  /** The static text/mention line inside the composer. */
  typed: ReactNode;
  /** The slash-command or mention popup, rendered between the text and footer. */
  popup: ReactNode;
  /** Machine / repository / branch row above the box. */
  topSelector?: ReactNode;
};

function ComposerPreview({ locale, caption, typed, popup, topSelector }: ComposerPreviewProps) {
  return (
    <div {...stylex.props(previewStyles.section)}>
      <div
        aria-hidden="true"
        className={['lody-app-preview', stylex.props(previewStyles.text).className].join(' ')}
      >
        <div {...stylex.props(previewStyles.frame)}>
          {topSelector ? <div {...stylex.props(previewStyles.row)}>{topSelector}</div> : null}
          <div
            {...stylex.props(previewStyles.stack, Boolean(topSelector) && previewStyles.section2)}
          >
            <div {...stylex.props(previewStyles.text2)}>
              {typed}
              <span aria-hidden="true" {...stylex.props(previewStyles.frame2)} />
            </div>
            {popup}
            <div {...stylex.props(previewStyles.row2)}>
              <div {...stylex.props(previewStyles.row3)}>
                <ReplicaRunConfigTrigger
                  agent="codex"
                  modelLabel="gpt-5.3-codex"
                  thinkLabel="xhigh"
                />
                <ReplicaPermissionModeTrigger label={PERMISSION_COPY[locale]} />
              </div>
              <ReplicaSendButton variant="session" disabled={false} />
            </div>
          </div>
        </div>
      </div>
      <div {...stylex.props(previewStyles.text3)}>{caption}</div>
    </div>
  );
}

/** The list surface: `MentionContent`'s popover box, inset one step. */
function PopupList({
  children,
  scrollbar = false,
}: {
  children: ReactNode;
  /** The slash menu scrolls once commands overflow; keep the quiet thumb. */
  scrollbar?: boolean;
}) {
  return (
    <div {...stylex.props(previewStyles.section3)}>
      {children}
      {scrollbar ? <span aria-hidden="true" {...stylex.props(previewStyles.overlay)} /> : null}
    </div>
  );
}

/**
 * `matchedRuns` in spirit: light the typed path segment and let the rest of the
 * row step back, so which part of a path the query matched is visible at a
 * glance.
 */
function HighlightedPath({ path, query }: { path: string; query: string }) {
  const index = query ? path.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (index < 0) return <span {...stylex.props(previewStyles.text4)}>{path}</span>;
  return (
    <>
      <span {...stylex.props(previewStyles.text5)}>{path.slice(0, index)}</span>
      <span {...stylex.props(previewStyles.text6)}>{path.slice(index, index + query.length)}</span>
      <span {...stylex.props(previewStyles.text4)}>{path.slice(index + query.length)}</span>
    </>
  );
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

type SlashCommand = {
  name: string;
  description: string;
};

/** Synthetic agent command list. The real list comes from ACP discovery. */
const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: '/debug',
    description: 'Enable debug logging for this session and help diagnose issues.',
  },
  {
    name: '/simplify',
    description: 'Review changed code for reuse, quality, and efficiency, then fix issues.',
  },
  {
    name: '/batch',
    description: 'Research and plan a large-scale change, then execute it in parallel.',
  },
  {
    name: '/loop',
    description: 'Run a prompt or slash command on a recurring interval.',
  },
  {
    name: '/review',
    description: 'Review the current changes and report findings.',
  },
];

const SLASH_CAPTION: Record<ReplicaLocale, string> = {
  en: 'Mock composer. Type / to open the command list; commands are synthetic and come from the agent.',
  zh: '模拟输入框。输入 / 打开命令列表；命令为模拟数据，由 Agent 提供。',
};

/** One `/command` row: the name, then the description on its own quiet line. */
function CommandRow({ command, selected }: { command: SlashCommand; selected?: boolean }) {
  return (
    <div {...stylex.props(previewStyles.stack2, selected ? previewStyles.section4 : false)}>
      <span {...stylex.props(previewStyles.text7)}>{command.name}</span>
      <span {...stylex.props(previewStyles.text8)}>{command.description}</span>
    </div>
  );
}

/**
 * A docs-owned, display-only slash-command popup over the home composer.
 * Sources: `mention-two-level-menu.tsx` (`CandidateRow` +
 * `toCommandCandidate`) and `combined-mention-textarea.tsx`.
 */
export function SlashCommandsPreview({ locale = 'en' }: { locale?: ReplicaLocale }) {
  const topSelector = (
    <>
      <ReplicaProjectSelectorTrigger label="loro-dev/lody" kind="github" locale={locale} />
      <ReplicaBranchWorktreePill
        branch="main"
        worktree={false}
        showWorktree={false}
        locale={locale}
      />
    </>
  );

  return (
    <ComposerPreview
      locale={locale}
      caption={SLASH_CAPTION[locale]}
      topSelector={topSelector}
      typed={<span {...stylex.props(previewStyles.text9)}>/</span>}
      popup={
        <PopupList scrollbar>
          {SLASH_COMMANDS.map((command, index) => (
            <CommandRow key={command.name} command={command} selected={index === 0} />
          ))}
        </PopupList>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Mentions (@ files, Issues / PRs, $ skills)
// ---------------------------------------------------------------------------

export type MentionPreviewKind = 'file' | 'issue' | 'skill';

type SkillScope = 'project' | 'global' | 'system';
type MentionCategoryLabel = 'file' | 'issue' | 'pr' | 'skill';

type MentionCopy = {
  caption: Record<MentionPreviewKind, string>;
  scope: Record<SkillScope, string>;
  category: Record<MentionCategoryLabel, string>;
};

const MENTION_COPY: Record<ReplicaLocale, MentionCopy> = {
  en: {
    caption: {
      file: 'Mock composer. Type @ to fuzzy-match files and folders in the selected project.',
      issue:
        'Mock composer. Type @, then choose Issues or Pull Requests to mention one from the selected repository.',
      skill: 'Mock composer. Type $ to browse the skills available to the project and machine.',
    },
    scope: { project: 'Project', global: 'Global', system: 'System' },
    category: { file: 'Files', issue: 'Issues', pr: 'Pull Requests', skill: 'Skills' },
  },
  zh: {
    caption: {
      file: '模拟输入框。输入 @ 可按文件名或路径模糊匹配所选项目中的文件和文件夹。',
      issue: '模拟输入框。输入 @ 后选择 Issues 或 Pull Requests，可提及所选仓库中的 Issue 或 PR。',
      skill: '模拟输入框。输入 $ 可浏览项目与机器上可用的 Skill。',
    },
    scope: { project: '项目', global: '全局', system: '系统' },
    category: { file: '文件', issue: 'Issues', pr: 'Pull Requests', skill: 'Skills' },
  },
};

type FileItem = {
  path: string;
  kind: 'dir' | 'file';
  /** The first folder carries the app's code-folder mark. */
  code?: boolean;
};

const FILE_QUERY = 'packages/shared/src';

/** Synthetic project paths from the app's own `packages/shared/src` shape. */
const FILE_ITEMS: readonly FileItem[] = [
  { path: 'packages/shared/src/', kind: 'dir', code: true },
  { path: 'packages/shared/src/acp/', kind: 'dir' },
  { path: 'packages/shared/src/node/', kind: 'dir' },
  { path: 'packages/shared/src/ai.ts', kind: 'file' },
  { path: 'packages/shared/src/auth.ts', kind: 'file' },
  { path: 'packages/shared/src/index.ts', kind: 'file' },
  { path: 'packages/shared/src/loro-server-auth.ts', kind: 'file' },
  { path: 'packages/shared/src/message-schemas.ts', kind: 'file' },
];

type SkillItem = {
  name: string;
  scope: SkillScope;
};

const SKILL_QUERY = 'review';

/** Synthetic skills, mirroring the story fixtures' project/global/system set. */
const SKILL_ITEMS: readonly SkillItem[] = [
  { name: 'review-agent', scope: 'system' },
  { name: 'code-collab-debug', scope: 'project' },
  { name: 'kill-ai-slop', scope: 'global' },
  { name: 'skill-creator', scope: 'system' },
  { name: 'openai-docs', scope: 'system' },
];

/** `toFileCandidate` + `CandidateIcon` for both folder marks and file glyphs. */
function FileRow({ item, selected }: { item: FileItem; selected?: boolean }) {
  return (
    <div {...stylex.props(previewStyles.row4, selected ? previewStyles.section4 : false)}>
      <span {...stylex.props(previewStyles.row5)}>
        {item.kind === 'dir' ? (
          item.code ? (
            <FolderCode {...stylex.props(previewStyles.text10)} strokeWidth={1.75} />
          ) : (
            <Folder {...stylex.props(previewStyles.frame3)} strokeWidth={1.75} />
          )
        ) : (
          <FileIcon path={item.path} xstyle={previewStyles.frame3} />
        )}
      </span>
      <span {...stylex.props(previewStyles.text11)}>
        <HighlightedPath path={item.path} query={FILE_QUERY} />
      </span>
    </div>
  );
}

/**
 * `CategoryRow` from the app's two-level menu: glyph, label, an optional
 * direct-trigger key, and the chevron into the next level.
 */
function MentionCategoryRow({
  icon: Icon,
  label,
  trailing,
  selected,
}: {
  icon: LucideIcon;
  label: string;
  trailing?: string;
  selected?: boolean;
}) {
  return (
    <div {...stylex.props(previewStyles.row6, selected ? previewStyles.section4 : false)}>
      <span {...stylex.props(previewStyles.row5)}>
        <Icon {...stylex.props(previewStyles.frame3)} strokeWidth={1.75} />
      </span>
      <span {...stylex.props(previewStyles.text12)}>{label}</span>
      {trailing ? <span {...stylex.props(previewStyles.text13)}>{trailing}</span> : null}
      <ChevronRight {...stylex.props(previewStyles.text14)} aria-hidden="true" />
    </div>
  );
}

/** `toSkillCandidate`: skill token first, scope trailing. */
function SkillRow({
  item,
  locale,
  selected,
}: {
  item: SkillItem;
  locale: ReplicaLocale;
  selected?: boolean;
}) {
  const copy = MENTION_COPY[locale];
  return (
    <div {...stylex.props(previewStyles.row6, selected ? previewStyles.section4 : false)}>
      <Sparkles {...stylex.props(previewStyles.text15)} strokeWidth={1.75} />
      <span {...stylex.props(previewStyles.text11)}>
        <HighlightedPath path={item.name} query={SKILL_QUERY} />
      </span>
      <span {...stylex.props(previewStyles.text16)}>{copy.scope[item.scope]}</span>
    </div>
  );
}

/**
 * A docs-owned, display-only mention popup over the home composer. `kind`
 * selects the surface covered by the old screenshots: `file` for the `@`
 * fuzzy path list, `issue` for the `@` category list that opens Issues and
 * Pull Requests, and `skill` for `$` skills. Sources:
 * `mention-two-level-menu.tsx` (`CategoryRow`/`CandidateRow`), the registry
 * candidate builders, and the `MentionTwoLevelMenu` story fixtures.
 */
export function MentionPreview({
  locale = 'en',
  kind = 'file',
}: {
  locale?: ReplicaLocale;
  kind?: MentionPreviewKind;
}) {
  const copy = MENTION_COPY[locale];
  const repo = kind === 'issue' ? 'loro-dev/loro-ts' : 'loro-dev/lody';
  const topSelector = (
    <>
      <ReplicaProjectSelectorTrigger label={repo} kind="github" locale={locale} />
      {kind === 'file' ? null : (
        <ReplicaBranchWorktreePill
          branch="main"
          worktree={false}
          showWorktree={false}
          locale={locale}
        />
      )}
    </>
  );

  if (kind === 'issue') {
    return (
      <ComposerPreview
        locale={locale}
        caption={copy.caption.issue}
        topSelector={topSelector}
        typed={<span {...stylex.props(previewStyles.text9)}>@</span>}
        popup={
          <PopupList>
            <MentionCategoryRow icon={Folder} label={copy.category.file} />
            <MentionCategoryRow icon={CircleDot} label={copy.category.issue} selected />
            <MentionCategoryRow icon={GitPullRequest} label={copy.category.pr} />
            <MentionCategoryRow icon={Boxes} label={copy.category.skill} trailing="$" />
          </PopupList>
        }
      />
    );
  }

  if (kind === 'skill') {
    return (
      <ComposerPreview
        locale={locale}
        caption={copy.caption.skill}
        topSelector={topSelector}
        typed={
          <span>
            <span {...stylex.props(previewStyles.text9)}>$</span>
            <span {...stylex.props(previewStyles.text17)}>{SKILL_QUERY}</span>
          </span>
        }
        popup={
          <PopupList>
            {SKILL_ITEMS.map((item, index) => (
              <SkillRow key={item.name} item={item} locale={locale} selected={index === 0} />
            ))}
          </PopupList>
        }
      />
    );
  }

  return (
    <ComposerPreview
      locale={locale}
      caption={copy.caption.file}
      topSelector={topSelector}
      typed={
        <span>
          <span {...stylex.props(previewStyles.text9)}>@</span>
          <span {...stylex.props(previewStyles.text18)}>{FILE_QUERY}</span>
        </span>
      }
      popup={
        <PopupList>
          {FILE_ITEMS.map((item, index) => (
            <FileRow key={item.path} item={item} selected={index === 0} />
          ))}
        </PopupList>
      }
    />
  );
}
