import * as React from 'react';
import { useAtomValue } from 'jotai';
import {
  compareProjectSkillScope,
  getRegisteredGlobalSkillDirs,
  getRegisteredSkillDirs,
  getRegisteredSystemSkillDirs,
  isRegisteredSkillAgentType,
  type AgentConfigCliType,
  type ProjectSkill,
  type ProjectSkillScope,
  type TextRewrite,
} from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms';
import {
  useProjectSkills,
  type ProjectSkillsSource,
  type ProjectSkillsStatus,
} from '@/hooks/use-project-skills';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
import {
  useMentionHydration,
  type HydratedMentions,
} from '@/components/mentions/mention-hydration';

/**
 * Skill mentions, reachable directly through `$` and through the `@` category
 * menu (phase 2 of docs/project-skills.md).
 *
 * Reuses the same discovery/SWR core as the Skills display tab via
 * `useProjectSkills`: the mention reads the CURRENT session project's skills
 * (local project root + that machine user's global skills over machine RPC, or
 * GitHub default branch over the API) and inserts a `$<token>` reference into
 * the composer text.
 *
 * What is typed: selecting a candidate inserts the literal text `$<token>` into
 * the composer (same model as `@file` / `#123`). Before send, known `$<token>`
 * references expand to `use /<token> [Skill Path](...)` so the agent receives
 * the provider-filtered skill path while the composer stays compact.
 */
export const SKILL_MENTION_TRIGGER = '$';
const SKILL_MENTION_PROMPT_PREFIX = '/';
/** Label of the expanded `[Skill Path](...)` markdown link. The writer and the
   already-expanded detector both derive from this so they cannot drift. */
const SKILL_MENTION_PATH_LABEL = 'Skill Path';
const SKILL_MENTION_PATH_ANNOTATION_RE = new RegExp(`^\\s*\\[${SKILL_MENTION_PATH_LABEL}\\]\\(`);
export type SkillMentionAgent = {
  cliType: AgentConfigCliType;
  agentType: string;
  machineId?: string;
};

export type SkillMentionItem = {
  /** The whitespace-free text inserted after `$`. */
  token: string;
  /** The skills directory this candidate came from (used to filter by the
     selected ACP provider's directories). */
  dir: string;
  scope: ProjectSkillScope;
  skill: ProjectSkill;
};

/**
 * The token inserted after `$`. Must be whitespace-free so the primitive's
 * trigger detection and the hydrator can scan `$<token>` up to the next space.
 * Prefers the frontmatter `name`; falls back to the skill directory basename
 * (always a path segment) when the name contains whitespace.
 */
export function getSkillMentionToken(skill: Pick<ProjectSkill, 'name' | 'relativePath'>): string {
  const name = skill.name.trim();
  if (name && /^\S+$/.test(name)) {
    return name;
  }
  const dir = skill.relativePath.replace(/\/SKILL\.md$/i, '');
  const base = dir.split('/').filter(Boolean).pop();
  return (base ?? name).replace(/\s+/g, '-');
}

export function buildSkillMentionItems(
  groups: ReadonlyArray<{ scope: ProjectSkillScope; dir: string; skills: readonly ProjectSkill[] }>
): SkillMentionItem[] {
  // One item per skill (NOT deduped here — duplicates/symlinks are kept so the
  // provider filter and token dedup below run over the full set).
  const items: SkillMentionItem[] = [];
  for (const group of groups) {
    for (const skill of group.skills) {
      const token = getSkillMentionToken(skill);
      if (!token) {
        continue;
      }
      items.push({ token, dir: group.dir, scope: group.scope, skill });
    }
  }
  return items.sort((left, right) => {
    if (left.token !== right.token) {
      return left.token.localeCompare(right.token);
    }
    if (left.scope !== right.scope) {
      return compareProjectSkillScope(left.scope, right.scope);
    }
    return left.dir.localeCompare(right.dir);
  });
}

/**
 * Picks the candidates shown in the `$` menu:
 *  1. Provider filter — when an ACP provider is selected, keep only skills from
 *     the directories that provider uses (`allowedDirs`); null = show all.
 *  2. Dedupe by token — the same `$<token>` surfaced from multiple dirs appears
 *     once (the inserted text is identical either way).
 *  3. Term filter + rank — prefix > substring > path match.
 */
export function selectSkillMentionCandidates(
  items: readonly SkillMentionItem[],
  term: string,
  allowedDirs: ReadonlySet<string> | null
): SkillMentionItem[] {
  const scoped = allowedDirs
    ? items.filter((item) => isSkillMentionDirAllowed(item.dir, allowedDirs))
    : items;
  const seen = new Set<string>();
  const deduped: SkillMentionItem[] = [];
  for (const item of scoped) {
    if (seen.has(item.token)) {
      continue;
    }
    seen.add(item.token);
    deduped.push(item);
  }

  const query = term.trim().toLowerCase();
  if (!query) {
    return deduped;
  }
  return deduped
    .map((item) => {
      const token = item.token.toLowerCase();
      const name = item.skill.name.toLowerCase();
      const path = item.skill.relativePath.toLowerCase();
      let score = -1;
      if (token.startsWith(query) || name.startsWith(query)) {
        score = 0;
      } else if (token.includes(query) || name.includes(query)) {
        score = 1;
      } else if (path.includes(query)) {
        score = 2;
      }
      return { item, score };
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.item.token.localeCompare(b.item.token))
    .map((entry) => entry.item);
}

function isSkillMentionDirAllowed(dir: string, allowedDirs: ReadonlySet<string>): boolean {
  if (allowedDirs.has(dir)) {
    return true;
  }
  for (const allowedDir of allowedDirs) {
    if (dir.startsWith(`${allowedDir}/`)) {
      return true;
    }
  }
  return false;
}

export function getAllowedSkillMentionDirs(
  skillAgent: { cliType?: AgentConfigCliType; agentType?: string } | undefined
): ReadonlySet<string> | null {
  if (!skillAgent?.cliType || !skillAgent.agentType) {
    return null;
  }
  // Unregistered types have no known dirs; an empty whitelist would hide every
  // skill, so they get none. A registered one keeps its whitelist when empty.
  if (!isRegisteredSkillAgentType(skillAgent.agentType)) {
    return null;
  }
  const agent = { cliType: skillAgent.cliType, agentType: skillAgent.agentType };
  return new Set([
    ...getRegisteredSkillDirs([agent]),
    ...getRegisteredGlobalSkillDirs([agent]),
    ...getRegisteredSystemSkillDirs([agent]),
  ]);
}

function getSkillMentionReferencePath(item: SkillMentionItem): string {
  // Home-scoped skills (global + system) expand to their absolute SKILL.md path;
  // project skills use the project-relative path.
  if (item.scope !== 'project') {
    return item.skill.absolutePath ?? item.skill.relativePath;
  }
  return item.skill.relativePath;
}

function formatSkillPathMarkdownDestination(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
}

function buildSkillMentionPathByToken(
  items: readonly SkillMentionItem[],
  allowedDirs: ReadonlySet<string> | null
): Map<string, string> {
  const pathByToken = new Map<string, string>();
  for (const item of selectSkillMentionCandidates(items, '', allowedDirs)) {
    pathByToken.set(item.token, getSkillMentionReferencePath(item));
  }
  return pathByToken;
}

/** Walk every `$<token>` span in `text` (whitespace-free, the shared skill
   mention trigger rule). `visit` returns `true` once it has consumed the token
   so scanning resumes after it, or `false` to advance a single char (so a
   nested `$` inside an unmatched run can still be found). */
function forEachSkillMentionSpan(
  text: string,
  visit: (span: { token: string; start: number; tokenEnd: number }) => boolean
): void {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== SKILL_MENTION_TRIGGER) {
      continue;
    }
    let tokenEnd = index + SKILL_MENTION_TRIGGER.length;
    while (tokenEnd < text.length) {
      const ch = text[tokenEnd];
      if (!ch || ch === ' ' || ch === '\n' || ch === '\t') {
        break;
      }
      tokenEnd += 1;
    }
    const token = text.slice(index + SKILL_MENTION_TRIGGER.length, tokenEnd);
    if (visit({ token, start: index, tokenEnd })) {
      index = tokenEnd - 1;
    }
  }
}

/**
 * The `$token` -> skill-instruction rewrites this text implies.
 *
 * Separate from applying them because the caller needs both halves: the agent
 * gets the instruction, and the transcript gets a span saying that region was
 * once `$token`. Rewrites are described against `text` and applied in one pass
 * with everything else — see `applyTextRewrites`.
 */
export function buildSkillMentionRewrites(
  text: string,
  items: readonly SkillMentionItem[],
  allowedDirs: ReadonlySet<string> | null
): TextRewrite[] {
  if (!text.includes(SKILL_MENTION_TRIGGER) || items.length === 0) {
    return [];
  }

  const pathByToken = buildSkillMentionPathByToken(items, allowedDirs);
  if (pathByToken.size === 0) {
    return [];
  }

  const rewrites: TextRewrite[] = [];
  forEachSkillMentionSpan(text, ({ token, start, tokenEnd }) => {
    const path = token ? pathByToken.get(token) : undefined;
    if (!path) {
      return false;
    }
    // Already expanded (idempotent re-send) — consume the token, rewrite nothing.
    if (SKILL_MENTION_PATH_ANNOTATION_RE.test(text.slice(tokenEnd))) {
      return true;
    }
    rewrites.push({
      start,
      end: tokenEnd,
      replacement: `use ${SKILL_MENTION_PROMPT_PREFIX}${token} [${SKILL_MENTION_PATH_LABEL}](${formatSkillPathMarkdownDestination(path)})`,
      span: { kind: 'skill', label: `${SKILL_MENTION_TRIGGER}${token}`, target: token },
    });
    return true;
  });

  return rewrites;
}

function hasProjectSkillSource(source: MentionProjectSource | undefined): boolean {
  if (source?.kind === 'local') {
    return Boolean(source.localProjectId && source.workspaceId && source.machineId);
  }
  if (source?.kind === 'github') {
    return Boolean(source.repoFullName);
  }
  if (source?.kind === 'provider') {
    return Boolean(source.githubRepoFullName);
  }
  return false;
}

/** The skill rewrites for a given text, bound to the current project's skills. */
export function useSkillMentionRewrites(
  source: MentionProjectSource | undefined,
  skillAgent: SkillMentionAgent | undefined,
  promptValue: string
): (text: string) => TextRewrite[] {
  const enableSkillMentions = hasProjectSkillSource(source) || Boolean(skillAgent?.machineId);
  const enabled = enableSkillMentions && promptValue.includes(SKILL_MENTION_TRIGGER);
  const { skillItems } = useMentionProjectSkills(source, enabled, skillAgent?.machineId);
  const skillAgentCliType = skillAgent?.cliType;
  const skillAgentAgentType = skillAgent?.agentType;
  const allowedDirs = React.useMemo(
    () =>
      getAllowedSkillMentionDirs({ cliType: skillAgentCliType, agentType: skillAgentAgentType }),
    [skillAgentAgentType, skillAgentCliType]
  );

  return React.useCallback(
    (text: string) => buildSkillMentionRewrites(text, skillItems, allowedDirs),
    [allowedDirs, skillItems]
  );
}

export function hydrateSkillMentionsFromText(
  text: string,
  knownTokens: ReadonlySet<string>
): HydratedMentions {
  const mentions: HydratedMentions['mentions'] = [];
  const values = new Set<string>();
  forEachSkillMentionSpan(text, ({ token, start, tokenEnd }) => {
    if (!token || !knownTokens.has(token)) {
      return false;
    }
    mentions.push({ value: token, start, end: tokenEnd, kind: 'skill' });
    values.add(token);
    return true;
  });
  return { mentions, values: Array.from(values) };
}

/** Collapse the project + global SWR states into the single status/error the
   skill menu renders. `idle` (a disabled source — e.g. global skipped for a
   local chat, or project skipped for a plain-agent chat) is ignored so the
   menu reflects whichever scopes are actually fetching. */
export function mergeMentionSkillState(
  states: ReadonlyArray<{ status: ProjectSkillsStatus; error?: string }>
): { status: ProjectSkillsStatus; error?: string } {
  const active = states.filter((state) => state.status !== 'idle');
  if (active.length === 0) {
    return { status: 'idle' };
  }
  if (active.some((state) => state.status === 'loading')) {
    return { status: 'loading' };
  }
  if (active.some((state) => state.status === 'refreshing')) {
    return { status: 'refreshing' };
  }
  // A successful empty scope must not hide another scope's failure. The menu
  // decides below whether discovered items are sufficient to remain usable;
  // with zero items this error becomes an actionable message instead of the
  // misleading "No results" state.
  if (active.some((state) => state.status === 'error')) {
    return { status: 'error', error: active.find((state) => state.error)?.error };
  }
  return { status: 'ready' };
}

/**
 * Resolves the current chat's skills for the mention.
 *
 * - Project scope: the local project root (machine RPC) or the GitHub default
 *   branch (API), from the mention `source`.
 * - Global scope: the skills of the machine the chat runs on (`globalMachineId`,
 *   e.g. `session.machineId` / the selected agent's machine). Surfaced for ALL
 *   chat kinds so a GitHub-project or plain-agent chat still offers the machine's
 *   global skills — not just local-project chats. For a `local` source we skip
 *   the separate global fetch because its own scan already includes that
 *   machine's globals (avoids double-listing).
 *
 * Gated by `enabled` so we only scan/fetch once the user actually engages a
 * skill-menu route (or a draft already contains a `$` token), mirroring the
 * display tab's lazy SWR.
 */
export function useMentionProjectSkills(
  source: MentionProjectSource | undefined,
  enabled: boolean,
  globalMachineId?: string | null
) {
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const kind = source?.kind;
  const localWorkspaceId = source?.kind === 'local' ? source.workspaceId : undefined;
  const machineId = source?.kind === 'local' ? source.machineId : undefined;
  const localProjectId = source?.kind === 'local' ? source.localProjectId : undefined;
  const repoFullName =
    source?.kind === 'github'
      ? source.repoFullName
      : source?.kind === 'provider'
        ? source.githubRepoFullName
        : undefined;

  const skillsSource = React.useMemo<ProjectSkillsSource | null>(() => {
    if (!enabled) {
      return null;
    }
    if (kind === 'local') {
      if (!localWorkspaceId || !machineId || !localProjectId) {
        return null;
      }
      return { kind: 'local', workspaceId: localWorkspaceId, machineId, localProjectId };
    }
    if (!repoFullName || !workspaceId) {
      return null;
    }
    return { kind: 'github', workspaceId, repoFullName };
  }, [enabled, kind, localWorkspaceId, machineId, localProjectId, repoFullName, workspaceId]);

  const globalSkillsSource = React.useMemo<ProjectSkillsSource | null>(() => {
    if (!enabled) {
      return null;
    }
    // A local source's own scan already lists its machine's global skills.
    if (kind === 'local') {
      return null;
    }
    const normalizedMachineId = globalMachineId?.trim();
    if (!normalizedMachineId || !workspaceId) {
      return null;
    }
    return { kind: 'global', workspaceId, machineId: normalizedMachineId };
  }, [enabled, kind, globalMachineId, workspaceId]);

  const projectSkillState = useProjectSkills(skillsSource);
  const globalSkillState = useProjectSkills(globalSkillsSource);

  const groups = React.useMemo(
    () => [...projectSkillState.groups, ...globalSkillState.groups],
    [projectSkillState.groups, globalSkillState.groups]
  );
  const skillState = React.useMemo(
    () => mergeMentionSkillState([projectSkillState, globalSkillState]),
    [projectSkillState, globalSkillState]
  );
  const skillItems = React.useMemo(() => buildSkillMentionItems(groups), [groups]);
  // All tokens (provider-agnostic) so hydration keeps an inserted `$token`
  // highlighted even after switching to a provider that wouldn't offer it.
  const knownSkillTokens = React.useMemo(
    () => new Set(skillItems.map((item) => item.token)),
    [skillItems]
  );
  return { skillState, skillItems, knownSkillTokens };
}

// ============================================================================
// Hydrator
// ============================================================================

export function SkillMentionHydrator({
  text,
  knownTokens,
  enabled,
}: {
  text: string;
  knownTokens: ReadonlySet<string>;
  enabled: boolean;
}) {
  const hydrate = React.useCallback(
    (value: string) =>
      knownTokens.size === 0 ? null : hydrateSkillMentionsFromText(value, knownTokens),
    [knownTokens]
  );
  useMentionHydration('SkillMentionHydrator', { text, enabled, hydrate });

  return null;
}
