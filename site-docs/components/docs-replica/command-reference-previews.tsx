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

import type { SiteLocale } from '@site/src/site-pages/shared';
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
import { cn } from '../landing-replica/utils';

// ---------------------------------------------------------------------------
// Shared composer shell
// ---------------------------------------------------------------------------

/** `ChatComposer`'s outer box, copied from the landing replica. */
const COMPOSER_BOX_CLASS =
  '@container/composer-box flex flex-col gap-1 rounded-xl border px-2 py-1.5 transition-colors duration-150 border-foreground/[0.10] bg-[hsl(var(--composer))] shadow-[0_3px_6px_-2px_lch(0%_0_0/0.02),0_1px_1px_lch(0%_0_0/0.04)] dark:shadow-none dark:border-input-border/70 dark:bg-input/90 [--mention-chip-surface:hsl(var(--composer))]';

const PERMISSION_COPY: Record<SiteLocale, string> = {
  en: 'Agent (full access)',
  zh: 'Agent（完全访问）',
  'zh-hant': 'Agent（完全存取）',
  ja: 'Agent（フルアクセス）',
  ko: 'Agent(전체 액세스)',
  es: 'Agent (acceso total)',
  fr: 'Agent (accès complet)',
  ru: 'Agent (полный доступ)',
};

type ComposerPreviewProps = {
  locale: SiteLocale;
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
    <div className="my-6">
      <div
        aria-hidden="true"
        className="lody-app-preview [--composer:var(--muted)] overflow-hidden rounded-xl border border-border bg-background p-4 text-foreground shadow-sm sm:p-6"
      >
        <div className="mx-auto w-full max-w-2xl">
          {topSelector ? (
            <div className="flex w-full min-w-0 select-none items-center gap-1">{topSelector}</div>
          ) : null}
          <div className={cn(COMPOSER_BOX_CLASS, topSelector && 'mt-1')}>
            <div className="min-h-8 px-1 pt-1 text-sm leading-6 text-input-foreground">
              {typed}
              <span
                aria-hidden="true"
                className="ml-px inline-block h-4 w-[1.5px] translate-y-0.5 rounded-full bg-foreground/70"
              />
            </div>
            {popup}
            <div className="flex items-center gap-1 pt-0.5">
              <div className="@container/composer-face flex min-w-0 flex-1 flex-nowrap items-center gap-x-1.5 overflow-hidden">
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
      <div className="mt-2 text-center text-xs text-muted-foreground">{caption}</div>
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
    <div className="relative mt-1 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg">
      {children}
      {scrollbar ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-1 top-2 h-1/3 w-1 rounded-full bg-foreground/15"
        />
      ) : null}
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
  if (index < 0) return <span className="text-foreground/90">{path}</span>;
  return (
    <>
      <span className="text-muted-foreground/80">{path.slice(0, index)}</span>
      <span className="font-medium text-primary">{path.slice(index, index + query.length)}</span>
      <span className="text-foreground/90">{path.slice(index + query.length)}</span>
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
const SLASH_COMMANDS_COPY: Record<SiteLocale, readonly SlashCommand[]> = {
  en: [
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
  ],
  zh: [
    {
      name: '/debug',
      description: '为当前会话开启调试日志并协助排查问题。',
    },
    {
      name: '/simplify',
      description: '审查已修改代码的复用性、质量与效率，并修复发现的问题。',
    },
    {
      name: '/batch',
      description: '调研并规划大规模改动，随后并行执行。',
    },
    {
      name: '/loop',
      description: '按固定时间间隔循环运行提示词或斜杠命令。',
    },
    {
      name: '/review',
      description: '审查当前改动并汇报发现的问题。',
    },
  ],
  'zh-hant': [
    {
      name: '/debug',
      description: '為目前工作階段啟用偵錯記錄並協助診斷問題。',
    },
    {
      name: '/simplify',
      description: '檢視已修改程式碼的重用性、品質與效率，並修復問題。',
    },
    {
      name: '/batch',
      description: '研究並規劃大規模變更，接著平行執行。',
    },
    {
      name: '/loop',
      description: '依固定間隔定期執行提示詞或斜線指令。',
    },
    {
      name: '/review',
      description: '審查目前的變更並回報發現的問題。',
    },
  ],
  ja: [
    {
      name: '/debug',
      description: 'このセッションのデバッグログを有効にし、問題の診断を支援します。',
    },
    {
      name: '/simplify',
      description: '変更されたコードの再利用性・品質・効率をレビューし、問題を修正します。',
    },
    {
      name: '/batch',
      description: '大規模な変更を調査・計画し、並列で実行します。',
    },
    {
      name: '/loop',
      description: 'プロンプトやスラッシュコマンドを一定間隔で繰り返し実行します。',
    },
    {
      name: '/review',
      description: '現在の変更内容をレビューして指摘事項を報告します。',
    },
  ],
  ko: [
    {
      name: '/debug',
      description: '이 세션의 디버그 로깅을 켜고 문제 진단을 돕습니다.',
    },
    {
      name: '/simplify',
      description: '변경된 코드의 재사용성, 품질, 효율성을 검토하고 문제를 수정합니다.',
    },
    {
      name: '/batch',
      description: '대규모 변경 사항을 조사하고 계획한 뒤 병렬로 실행합니다.',
    },
    {
      name: '/loop',
      description: '프롬프트나 슬래시 명령어를 일정 간격으로 반복 실행합니다.',
    },
    {
      name: '/review',
      description: '현재 변경 사항을 검토하고 결과를 보고합니다.',
    },
  ],
  es: [
    {
      name: '/debug',
      description:
        'Activa el registro de depuración en esta sesión y ayuda a diagnosticar problemas.',
    },
    {
      name: '/simplify',
      description:
        'Revisa el código modificado para mejorar reutilización, calidad y eficiencia, y corrige incidencias.',
    },
    {
      name: '/batch',
      description: 'Investiga y planifica un cambio a gran escala y luego ejecútalo en paralelo.',
    },
    {
      name: '/loop',
      description: 'Ejecuta un prompt o comando de barra en un intervalo recurrente.',
    },
    {
      name: '/review',
      description: 'Revisa los cambios actuales e informa los hallazgos.',
    },
  ],
  fr: [
    {
      name: '/debug',
      description:
        'Active la journalisation de débogage pour cette session et aide à diagnostiquer les problèmes.',
    },
    {
      name: '/simplify',
      description:
        'Examine le code modifié pour sa réutilisabilité, sa qualité et son efficacité, puis corrige les problèmes.',
    },
    {
      name: '/batch',
      description: 'Analyse et planifie un changement d’envergure, puis l’exécute en parallèle.',
    },
    {
      name: '/loop',
      description: 'Exécute un prompt ou une commande slash à intervalle régulier.',
    },
    {
      name: '/review',
      description: 'Examine les modifications en cours et signale les points relevés.',
    },
  ],
  ru: [
    {
      name: '/debug',
      description:
        'Включает отладочное логирование для этой сессии и помогает диагностировать проблемы.',
    },
    {
      name: '/simplify',
      description:
        'Проверяет изменённый код на переиспользование, качество и эффективность, затем исправляет замечания.',
    },
    {
      name: '/batch',
      description: 'Исследует и планирует масштабное изменение, затем выполняет его параллельно.',
    },
    {
      name: '/loop',
      description: 'Запускает промпт или слэш-команду с заданным интервалом.',
    },
    {
      name: '/review',
      description: 'Проверяет текущие изменения и сообщает о найденных проблемах.',
    },
  ],
};

const SLASH_CAPTION: Record<SiteLocale, string> = {
  en: 'Mock composer. Type / to open the command list; commands are synthetic and come from the agent.',
  zh: '模拟输入框。输入 / 打开命令列表；命令为模拟数据，由 Agent 提供。',
  'zh-hant': '模擬輸入框。輸入 / 開啟指令列表；指令為模擬資料，由 Agent 提供。',
  ja: 'モック入力欄です。/ を入力するとコマンド一覧が開きます。コマンドはモックデータで、エージェントから提供されます。',
  ko: '모의 입력창입니다. /를 입력하면 명령어 목록이 열립니다. 명령어는 모의 데이터이며 에이전트가 제공합니다.',
  es: 'Compositor de ejemplo. Escribe / para abrir la lista de comandos; los comandos son sintéticos y provienen del agente.',
  fr: 'Zone de saisie factice. Saisissez / pour ouvrir la liste des commandes ; les commandes sont factices et fournies par l’agent.',
  ru: 'Демонстрационное поле ввода. Введите /, чтобы открыть список команд; команды приведены для примера и предоставляются агентом.',
};

/** One `/command` row: the name, then the description on its own quiet line. */
function CommandRow({ command, selected }: { command: SlashCommand; selected?: boolean }) {
  return (
    <div
      className={cn(
        'mx-1 flex flex-col rounded-md px-2 py-1.5',
        selected ? 'bg-selection' : undefined
      )}
    >
      <span className="truncate text-sm font-medium leading-6 text-foreground">{command.name}</span>
      <span className="truncate text-[13px] leading-5 text-muted-foreground">
        {command.description}
      </span>
    </div>
  );
}

/**
 * A docs-owned, display-only slash-command popup over the home composer.
 * Sources: `mention-two-level-menu.tsx` (`CandidateRow` +
 * `toCommandCandidate`) and `combined-mention-textarea.tsx`.
 */
export function SlashCommandsPreview({ locale = 'en' }: { locale?: SiteLocale }) {
  const commands = SLASH_COMMANDS_COPY[locale];
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
      typed={<span className="text-foreground">/</span>}
      popup={
        <PopupList scrollbar>
          {commands.map((command, index) => (
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

const MENTION_COPY: Record<SiteLocale, MentionCopy> = {
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
  'zh-hant': {
    caption: {
      file: '模擬輸入框。輸入 @ 可依檔案名稱或路徑模糊比對所選專案中的檔案與資料夾。',
      issue:
        '模擬輸入框。輸入 @ 後選擇 Issues 或 Pull Requests，即可提及所選儲存庫中的 Issue 或 PR。',
      skill: '模擬輸入框。輸入 $ 可瀏覽專案與機器上可用的 Skill。',
    },
    scope: { project: '專案', global: '全域', system: '系統' },
    category: { file: '檔案', issue: 'Issues', pr: 'Pull Requests', skill: 'Skills' },
  },
  ja: {
    caption: {
      file: 'モック入力欄です。@ を入力すると、選択中プロジェクトのファイルやフォルダーをあいまい検索できます。',
      issue:
        'モック入力欄です。@ を入力して Issues または Pull Requests を選ぶと、選択中リポジトリの Issue や PR を参照できます。',
      skill:
        'モック入力欄です。$ を入力すると、プロジェクトやマシンで利用可能なスキルを一覧できます。',
    },
    scope: { project: 'プロジェクト', global: 'グローバル', system: 'システム' },
    category: { file: 'ファイル', issue: 'Issues', pr: 'Pull Requests', skill: 'Skills' },
  },
  ko: {
    caption: {
      file: '모의 입력창입니다. @를 입력하면 선택한 프로젝트의 파일과 폴더를 퍼지 검색할 수 있습니다.',
      issue:
        '모의 입력창입니다. @를 입력한 뒤 Issues 또는 Pull Requests를 선택해 저장소의 이슈나 PR을 멘션할 수 있습니다.',
      skill:
        '모의 입력창입니다. $를 입력하면 프로젝트와 머신에서 사용할 수 있는 스킬을 탐색할 수 있습니다.',
    },
    scope: { project: '프로젝트', global: '전역', system: '시스템' },
    category: { file: '파일', issue: 'Issues', pr: 'Pull Requests', skill: 'Skills' },
  },
  es: {
    caption: {
      file: 'Compositor de ejemplo. Escribe @ para buscar de forma aproximada archivos y carpetas del proyecto seleccionado.',
      issue:
        'Compositor de ejemplo. Escribe @ y elige Issues o Pull Requests para mencionar uno del repositorio seleccionado.',
      skill:
        'Compositor de ejemplo. Escribe $ para explorar las skills disponibles en el proyecto y la máquina.',
    },
    scope: { project: 'Proyecto', global: 'Global', system: 'Sistema' },
    category: { file: 'Archivos', issue: 'Issues', pr: 'Pull Requests', skill: 'Skills' },
  },
  fr: {
    caption: {
      file: 'Zone de saisie factice. Saisissez @ pour rechercher par correspondance floue des fichiers et dossiers du projet sélectionné.',
      issue:
        'Zone de saisie factice. Saisissez @ puis choisissez Issues ou Pull Requests pour en mentionner une du dépôt sélectionné.',
      skill:
        'Zone de saisie factice. Saisissez $ pour parcourir les skills disponibles pour le projet et la machine.',
    },
    scope: { project: 'Projet', global: 'Global', system: 'Système' },
    category: { file: 'Fichiers', issue: 'Issues', pr: 'Pull Requests', skill: 'Skills' },
  },
  ru: {
    caption: {
      file: 'Демонстрационное поле ввода. Введите @ для нечёткого поиска файлов и папок в выбранном проекте.',
      issue:
        'Демонстрационное поле ввода. Введите @ и выберите Issues или Pull Requests, чтобы упомянуть задачу или PR из выбранного репозитория.',
      skill:
        'Демонстрационное поле ввода. Введите $, чтобы просмотреть навыки, доступные для проекта и машины.',
    },
    scope: { project: 'Проект', global: 'Глобально', system: 'Система' },
    category: { file: 'Файлы', issue: 'Issues', pr: 'Pull Requests', skill: 'Навыки' },
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
    <div
      className={cn(
        'mx-1 flex min-w-0 items-center gap-2 rounded-md px-2 py-1',
        selected ? 'bg-selection' : undefined
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
        {item.kind === 'dir' ? (
          item.code ? (
            <FolderCode className="h-4 w-4 text-status-warning" strokeWidth={1.75} />
          ) : (
            <Folder className="h-4 w-4" strokeWidth={1.75} />
          )
        ) : (
          <FileIcon path={item.path} className="h-4 w-4" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm leading-6">
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
    <div
      className={cn(
        'mx-1 flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5',
        selected ? 'bg-selection' : undefined
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
        <Icon className="h-4 w-4" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm leading-6 text-foreground">{label}</span>
      {trailing ? (
        <span className="shrink-0 font-mono text-[11px] leading-none text-muted-foreground">
          {trailing}
        </span>
      ) : null}
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
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
  locale: SiteLocale;
  selected?: boolean;
}) {
  const copy = MENTION_COPY[locale];
  return (
    <div
      className={cn(
        'mx-1 flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5',
        selected ? 'bg-selection' : undefined
      )}
    >
      <Sparkles className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate text-sm leading-6">
        <HighlightedPath path={item.name} query={SKILL_QUERY} />
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{copy.scope[item.scope]}</span>
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
  locale?: SiteLocale;
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
        typed={<span className="text-foreground">@</span>}
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
            <span className="text-foreground">$</span>
            <span className="rounded-[3px] bg-primary/15 px-px font-medium text-foreground">
              {SKILL_QUERY}
            </span>
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
          <span className="text-foreground">@</span>
          <span className="rounded-[3px] bg-primary/15 px-px text-foreground">{FILE_QUERY}</span>
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
