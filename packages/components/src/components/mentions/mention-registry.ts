import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { AcpCommandSummary } from '@lody/shared';
import { filterAndRankSlashCommands } from '@/lib/command-slash-search';
import {
  buildPathSuggestions,
  getSuggestions,
  type FuseInstance,
  type PathSuggestion,
} from '@/components/mentions/file-at-mention';
import {
  getIssuePrSuggestions,
  type ItemSuggestion as IssuePrSuggestion,
} from '@/components/mentions/issue-pr-hash-mention';
import {
  SKILL_MENTION_TRIGGER,
  selectSkillMentionCandidates,
  type SkillMentionItem,
} from '@/components/mentions/mention-skill-source';
import {
  SESSION_MENTION_PREFIX,
  selectSessionMentionCandidates,
  type SessionMentionItem,
} from '@/components/mentions/mention-session-source';
import { parseMentionNamespaceSearch } from '@/ui/mention/mention-trigger';
import type { MentionKind } from '@/ui/mention/index';

/**
 * The single composer trigger. Every category is reached through `@`; the
 * per-type markers (`#`, `$`, `/`) survive only as the text a committed
 * candidate writes, so the prompt an agent receives is unchanged.
 */
export const MENTION_TRIGGER = '@';

/** Per-category cap when one query is answered across every category. */
export const AGGREGATE_LIMIT_PER_CATEGORY = 4;

export type MentionCategoryId = 'file' | 'issue' | 'pr' | 'skill' | 'command' | 'session';

export type MentionIcon = 'file' | 'dir' | 'issue' | 'pr' | 'skill' | 'command' | 'session';

export type MentionCategoryStatus = 'ready' | 'loading' | 'error';

/**
 * Side-panel content for a highlighted candidate. Deliberately neutral: the
 * menu renders one pane for every category, so a source describes its detail in
 * plain fields rather than shipping its own component.
 */
export type MentionCandidateDetail = {
  title: string;
  badges?: string[];
  description?: string;
  rows?: Array<{ label: string; value: string; mono?: boolean }>;
};

export type MentionCandidate = {
  /** Payload recorded on the mention range; also the row key. */
  value: string;
  /** What the user can type to match exactly, driving Enter-on-exact-match. */
  label: string;
  /**
   * Literal text written into the composer. Carries its own marker because it
   * replaces everything from the trigger to the caret.
   */
  insertText: string;
  /** Set when selecting the candidate descends a level instead of committing. */
  navigateText?: string;
  kind: MentionKind;
  icon: MentionIcon;
  title: string;
  subtitle?: string;
  trailing?: string;
  /** Render the title in the monospace face (paths, tokens). */
  mono?: boolean;
  /** Path an extension-aware icon derives its glyph from. */
  iconPath?: string;
  /** Rendered in the desktop side panel while this candidate is highlighted. */
  detail?: MentionCandidateDetail;
};

export type MentionCategory = {
  id: MentionCategoryId;
  /** The `<namespace>:` segment of the drill-down prefix. */
  namespace: string;
  /**
   * A trigger character that opens this category directly, bypassing the
   * category list. Only `/` keeps one: a slash command must own the whole
   * prompt, so it never nests under a category.
   */
  directTrigger?: string;
  label: string;
  icon: MentionIcon;
  status: MentionCategoryStatus;
  /** Rendered instead of rows: an error, or "select a repo first". */
  message?: string;
  /** Rendered above the rows, e.g. the truncated-file-list warning. */
  notice?: string;
  /**
   * Candidates for a term inside this category. Lazy on purpose: ranking the
   * file index is the expensive one, and a query aimed at another category
   * must not pay for it. `limit` is passed down to the source so the aggregate
   * level, which shows a handful of rows per category, does not build a
   * candidate object for every ranked result it is about to drop.
   */
  getCandidates: (term: string, limit?: number) => MentionCandidate[];
};

export type MentionCandidateGroup = {
  category: MentionCategory;
  candidates: MentionCandidate[];
};

export type MentionMenuView =
  /** `@` — first level, nothing typed yet. */
  | { level: 'categories'; categories: MentionCategory[] }
  /** `@foo` — one query answered across every category. */
  | {
      level: 'aggregate';
      term: string;
      /** Categories whose own name matches, offered above the results. */
      categories: MentionCategory[];
      groups: MentionCandidateGroup[];
    }
  /** `@issue:foo` — second level, scoped to one category. */
  | {
      level: 'category';
      category: MentionCategory;
      term: string;
      candidates: MentionCandidate[];
    };

/** The drill-down text that opens a category's second level. */
export function getCategoryNavigateText(category: Pick<MentionCategory, 'namespace'>): string {
  return `${MENTION_TRIGGER}${category.namespace}:`;
}

/** Every candidate the view is currently showing, in display order. */
export function getMentionViewCandidates(view: MentionMenuView | null): MentionCandidate[] {
  if (!view) return [];
  if (view.level === 'category') return view.candidates;
  if (view.level === 'aggregate') return view.groups.flatMap((group) => group.candidates);
  return [];
}

function matchesCategoryName(category: MentionCategory, term: string): boolean {
  const query = term.toLowerCase();
  return category.namespace.startsWith(query) || category.label.toLowerCase().includes(query);
}

/**
 * Resolve what the menu should show for the text between the trigger and the
 * caret. Pure over the categories so the two-level contract can be tested
 * without rendering.
 */
export function selectMentionMenuView(
  categories: readonly MentionCategory[],
  search: string,
  options?: { aggregateLimitPerCategory?: number }
): MentionMenuView {
  const namespaced = parseMentionNamespaceSearch(search);
  if (namespaced) {
    const category = categories.find((entry) => entry.namespace === namespaced.namespace);
    if (category) {
      const { term } = namespaced;
      return { level: 'category', category, term, candidates: category.getCandidates(term) };
    }
  }

  if (!search) {
    return { level: 'categories', categories: [...categories] };
  }

  const limit = options?.aggregateLimitPerCategory ?? AGGREGATE_LIMIT_PER_CATEGORY;
  const groups: MentionCandidateGroup[] = [];
  for (const category of categories) {
    // `limit` is passed down so a source can stop early, and enforced here so
    // the cap holds whether or not it did.
    const candidates = category.getCandidates(search, limit).slice(0, limit);
    if (candidates.length > 0) groups.push({ category, candidates });
  }

  return {
    level: 'aggregate',
    term: search,
    categories: categories.filter((category) => matchesCategoryName(category, search)),
    groups,
  };
}

/**
 * The view for the active trigger. `@` runs the full two-level contract; a
 * category with a `directTrigger` opens straight into its own level.
 */
export function selectMentionMenuViewForTrigger(
  categories: readonly MentionCategory[],
  trigger: string,
  search: string,
  options?: { aggregateLimitPerCategory?: number }
): MentionMenuView | null {
  if (trigger === MENTION_TRIGGER) {
    return selectMentionMenuView(categories, search, options);
  }
  const direct = categories.find((entry) => entry.directTrigger === trigger);
  if (!direct) return null;
  return {
    level: 'category',
    category: direct,
    term: search,
    candidates: direct.getCandidates(search),
  };
}

// ============================================================================
// Candidate builders
// ============================================================================

/** Cut a ranked list down before it is mapped into candidate objects. */
function applyLimit<T>(ranked: T[], limit: number | undefined): T[] {
  return limit === undefined || ranked.length <= limit ? ranked : ranked.slice(0, limit);
}

export type FileSuggestionIndex = {
  dirs: PathSuggestion[];
  files: PathSuggestion[];
  allSuggestions: PathSuggestion[];
};

/**
 * Rankable file index for the mention menu. The GitHub/worktree tree only
 * yields files, so directories are synthesised by `buildPathSuggestions`;
 * lazily-listed directories are folded in on top so `@` completion can offer a
 * directory it has not expanded yet.
 */
export function buildMentionFileIndex(
  entry: { paths: string[]; lazyDirectories?: ReadonlyArray<{ path: string }> } | null,
  buildLazyDirectoryToken: (path: string) => string | null
): FileSuggestionIndex | null {
  if (!entry) return null;
  const base = buildPathSuggestions(entry.paths);
  const tokens = new Set(base.allTokens);
  const lazyDirs: PathSuggestion[] = [];
  for (const lazy of entry.lazyDirectories ?? []) {
    const token = buildLazyDirectoryToken(lazy.path);
    if (!token || tokens.has(token)) continue;
    tokens.add(token);
    lazyDirs.push({
      kind: 'dir',
      path: token.replace(/\/+$/u, ''),
      token,
      searchable: token.toLowerCase(),
    });
  }
  if (lazyDirs.length === 0) return base;
  const dirs = [...base.dirs, ...lazyDirs].sort((left, right) =>
    left.token.localeCompare(right.token)
  );
  return { dirs, files: base.files, allSuggestions: [...dirs, ...base.files] };
}

export function toFileCandidate(item: PathSuggestion): MentionCandidate {
  const isDirectory = item.kind === 'dir';
  return {
    value: item.token,
    label: item.token,
    // Committing a directory drops the trailing slash so the text reads
    // `@src/components`; selecting it descends into `@src/components/`.
    insertText: `${MENTION_TRIGGER}${isDirectory ? item.token.replace(/\/+$/, '') : item.token}`,
    navigateText: isDirectory ? `${MENTION_TRIGGER}${item.token}` : undefined,
    kind: isDirectory ? 'dir' : 'file',
    icon: isDirectory ? 'dir' : 'file',
    title: item.token,
    iconPath: item.path,
    mono: true,
  };
}

export function buildFileCandidates(
  index: FileSuggestionIndex | null,
  term: string,
  fuse: FuseInstance<PathSuggestion> | null,
  limit?: number
): MentionCandidate[] {
  if (!index) return [];
  return applyLimit(getSuggestions(index, term, fuse), limit).map(toFileCandidate);
}

export function toIssuePrCandidate(item: IssuePrSuggestion): MentionCandidate {
  return {
    value: item.token,
    label: item.label,
    // `#123` keeps its GitHub meaning in the prompt.
    insertText: item.token,
    kind: item.type,
    icon: item.type,
    title: item.title,
    trailing: item.token,
  };
}

/**
 * Issues and PRs share one cache but rank separately, so each category ranks
 * over its own slice — the shared ranking caps its result set, and ranking the
 * merged list first would let one type starve the other. `scoped` is that
 * slice, partitioned once by the caller rather than per keystroke.
 */
export function buildIssuePrCandidates(
  scoped: IssuePrSuggestion[],
  term: string,
  fuse: FuseInstance<IssuePrSuggestion> | null,
  limit?: number
): MentionCandidate[] {
  return applyLimit(getIssuePrSuggestions(scoped, term, fuse), limit).map(toIssuePrCandidate);
}

/** i18n'd labels for the skill detail panel, supplied by `useMentionCategories`. */
export type SkillDetailLabels = {
  author: string;
  path: string;
  linksTo: string;
  symlink: string;
  /** Scope badge text, keyed by `SkillMentionItem['scope']`. */
  scope: Record<SkillMentionItem['scope'], string>;
};

export function toSkillCandidate(
  item: SkillMentionItem,
  labels: SkillDetailLabels
): MentionCandidate {
  const { skill } = item;
  const rows: NonNullable<MentionCandidateDetail['rows']> = [];
  if (skill.author) rows.push({ label: labels.author, value: skill.author });
  rows.push({ label: labels.path, value: skill.relativePath, mono: true });
  if (skill.symlinkTarget) {
    rows.push({ label: labels.linksTo, value: skill.symlinkTarget, mono: true });
  }
  return {
    value: item.token,
    label: item.token,
    // Expanded to `use /token [Skill Path](...)` before send.
    insertText: `${SKILL_MENTION_TRIGGER}${item.token}`,
    kind: 'skill',
    icon: 'skill',
    title: item.token,
    detail: {
      title: skill.name,
      badges: [
        labels.scope[item.scope],
        ...(skill.version ? [`v${skill.version}`] : []),
        ...(skill.isSymlink ? [labels.symlink] : []),
      ],
      description: skill.description,
      rows,
    },
  };
}

export function buildSkillCandidates(
  items: readonly SkillMentionItem[],
  term: string,
  allowedDirs: ReadonlySet<string> | null,
  labels: SkillDetailLabels,
  limit?: number
): MentionCandidate[] {
  return applyLimit(selectSkillMentionCandidates(items, term, allowedDirs), limit).map((item) =>
    toSkillCandidate(item, labels)
  );
}

export type SessionDetailLabels = {
  untitled: string;
};

export function toSessionCandidate(
  item: SessionMentionItem,
  labels: SessionDetailLabels
): MentionCandidate {
  return {
    // The range payload is the real id; the text only ever carries the slug.
    value: item.sessionId,
    label: item.slug,
    insertText: `${SESSION_MENTION_PREFIX}${item.slug}`,
    kind: 'session',
    icon: 'session',
    title: item.title || labels.untitled,
    subtitle: item.projectLabel,
  };
}

export function buildSessionCandidates(
  items: readonly SessionMentionItem[],
  term: string,
  labels: SessionDetailLabels,
  limit?: number
): MentionCandidate[] {
  return selectSessionMentionCandidates(items, term, limit).map((item) =>
    toSessionCandidate(item, labels)
  );
}

export function toCommandCandidate(command: AcpCommandSummary): MentionCandidate {
  return {
    value: command.name,
    label: command.name,
    // A slash command already owns the whole prompt: its `/` trigger only fires
    // on a slash-only composer, so the trigger span *is* the prompt.
    insertText: `/${command.name}`,
    kind: 'command',
    icon: 'command',
    title: `/${command.name}`,
    subtitle: command.description,
  };
}

export function buildCommandCandidates(
  commands: readonly AcpCommandSummary[],
  term: string,
  limit?: number
): MentionCandidate[] {
  return applyLimit(filterAndRankSlashCommands([...commands], term), limit).map(toCommandCandidate);
}

// ============================================================================
// Hook
// ============================================================================

type SourceState = {
  enabled: boolean;
  status?: MentionCategoryStatus;
  message?: string;
};

export type MentionCategorySources = {
  file?: SourceState & {
    index: FileSuggestionIndex | null;
    fuse: FuseInstance<PathSuggestion> | null;
    notice?: string;
  };
  issuePr?: SourceState & {
    suggestions: readonly IssuePrSuggestion[];
    /**
     * Builds a matcher over one category's slice. The caller owns loading the
     * Fuse constructor so the menu keeps its module-cached, activation-keyed
     * loading; returning null falls back to substring matching.
     */
    createFuse: (list: IssuePrSuggestion[]) => FuseInstance<IssuePrSuggestion> | null;
  };
  skill?: SourceState & {
    items: readonly SkillMentionItem[];
    allowedDirs: ReadonlySet<string> | null;
  };
  command?: SourceState & {
    commands: readonly AcpCommandSummary[];
  };
  session?: SourceState & {
    items: readonly SessionMentionItem[];
  };
};

/**
 * The enabled mention categories, in first-level display order. Files lead
 * because selecting a file is by far the most common reason to open the menu.
 */
export function useMentionCategories(sources: MentionCategorySources): MentionCategory[] {
  const { t } = useTranslation();
  const { file, issuePr, skill, command, session } = sources;

  // Partitioned once and shared with the Fuse indexes: the cache holds both
  // types, and re-splitting it inside `getCandidates` walked the whole list
  // twice on every keystroke.
  const issueSuggestions = React.useMemo(
    () => (issuePr?.enabled ? issuePr.suggestions.filter((item) => item.type === 'issue') : []),
    [issuePr]
  );
  const prSuggestions = React.useMemo(
    () => (issuePr?.enabled ? issuePr.suggestions.filter((item) => item.type === 'pr') : []),
    [issuePr]
  );
  const createIssuePrFuse = issuePr?.createFuse;
  const issueFuse = React.useMemo(
    () => createIssuePrFuse?.(issueSuggestions) ?? null,
    [createIssuePrFuse, issueSuggestions]
  );
  const prFuse = React.useMemo(
    () => createIssuePrFuse?.(prSuggestions) ?? null,
    [createIssuePrFuse, prSuggestions]
  );

  return React.useMemo(() => {
    const categories: MentionCategory[] = [];

    if (file?.enabled) {
      categories.push({
        id: 'file',
        namespace: 'file',
        label: t('mention.category.file.label', 'Files'),
        icon: 'file',
        status: file.status ?? 'ready',
        message: file.message,
        notice: file.notice,
        getCandidates: (term, limit) => buildFileCandidates(file.index, term, file.fuse, limit),
      });
    }

    if (issuePr?.enabled) {
      categories.push({
        id: 'issue',
        namespace: 'issue',
        label: t('mention.category.issue.label', 'Issues'),
        icon: 'issue',
        status: issuePr.status ?? 'ready',
        message: issuePr.message,
        getCandidates: (term, limit) =>
          buildIssuePrCandidates(issueSuggestions, term, issueFuse, limit),
      });
      categories.push({
        id: 'pr',
        namespace: 'pr',
        label: t('mention.category.pr.label', 'Pull Requests'),
        icon: 'pr',
        status: issuePr.status ?? 'ready',
        message: issuePr.message,
        getCandidates: (term, limit) => buildIssuePrCandidates(prSuggestions, term, prFuse, limit),
      });
    }

    if (skill?.enabled) {
      categories.push({
        id: 'skill',
        namespace: 'skill',
        label: t('mention.category.skill.label', 'Skills'),
        icon: 'skill',
        status: skill.status ?? 'ready',
        message: skill.message,
        getCandidates: (term, limit) =>
          buildSkillCandidates(
            skill.items,
            term,
            skill.allowedDirs,
            {
              author: t('workspace.projects.skills.mention.detailAuthor', 'Author'),
              path: t('workspace.projects.skills.mention.detailPath', 'Path'),
              linksTo: t('workspace.projects.skills.mention.detailLinksTo', 'Links to'),
              symlink: t('workspace.projects.skills.mention.detailSymlink', 'symlink'),
              // Same keys as the Skills tab's scope badge — the pane must not
              // fall back to the raw enum value.
              scope: {
                project: t('workspace.projects.skills.scopeProject', 'Project'),
                global: t('workspace.projects.skills.scopeGlobal', 'Global'),
                system: t('workspace.projects.skills.scopeSystem', 'System'),
              },
            },
            limit
          ),
      });
    }

    if (session?.enabled) {
      categories.push({
        id: 'session',
        namespace: 'session',
        label: t('mention.category.session.label', 'Sessions'),
        icon: 'session',
        status: session.status ?? 'ready',
        message: session.message,
        getCandidates: (term, limit) =>
          buildSessionCandidates(
            session.items,
            term,
            { untitled: t('mention.session.untitled', 'Untitled session') },
            limit
          ),
      });
    }

    if (command?.enabled) {
      categories.push({
        id: 'command',
        namespace: 'cmd',
        directTrigger: '/',
        label: t('mention.category.command.label', 'Commands'),
        icon: 'command',
        status: command.status ?? 'ready',
        message: command.message,
        getCandidates: (term, limit) => buildCommandCandidates(command.commands, term, limit),
      });
    }

    return categories;
  }, [
    command,
    file,
    issueFuse,
    issuePr,
    issueSuggestions,
    prFuse,
    prSuggestions,
    session,
    skill,
    t,
  ]);
}
