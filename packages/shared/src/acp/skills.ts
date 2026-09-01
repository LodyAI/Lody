import type { AgentConfigCliType } from '../ai';

export const DEFAULT_PROJECT_SKILL_DIR = '.agents/skills';
export const DEFAULT_AGENTS_GLOBAL_SKILL_DIR = '~/.agents/skills';
export const DEFAULT_GLOBAL_SKILL_DIR = '~/.config/agents/skills';
const CLAUDE_PROJECT_SKILL_DIR = '.claude/skills';
const CLAUDE_GLOBAL_SKILL_DIR = '~/.claude/skills';
const FACTORY_COMPAT_PROJECT_SKILL_DIR = '.agent/skills';
/** Codex ships its own built-in ("system") skills under this home-relative
   catalog dir, separate from the user-authored skills in the agent's global
   dir. Surfaced under the dedicated `'system'` scope. */
const CODEX_SYSTEM_SKILL_DIR = '~/.codex/skills/.system';

type SkillDirsByAgentType = {
  projectDirs: string[];
  globalDirs: string[];
  /** Home-relative dirs holding the agent's built-in/system skills. Scanned like
     global dirs but surfaced under the `'system'` scope. Most agents have none. */
  systemDirs: string[];
};

function skillDirs(
  projectDirs: string[],
  globalDirs: string[],
  systemDirs: string[] = []
): SkillDirsByAgentType {
  return { projectDirs, globalDirs, systemDirs };
}

export const ACP_SKILL_DIRS_BY_AGENT_TYPE: Record<string, SkillDirsByAgentType> = {
  adal: skillDirs(['.adal/skills'], ['~/.adal/skills']),
  'aider-desk': skillDirs(['.aider-desk/skills'], ['~/.aider-desk/skills']),
  'amp-acp': skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, CLAUDE_PROJECT_SKILL_DIR],
    [DEFAULT_GLOBAL_SKILL_DIR, CLAUDE_GLOBAL_SKILL_DIR]
  ),
  amp: skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, CLAUDE_PROJECT_SKILL_DIR],
    [DEFAULT_GLOBAL_SKILL_DIR, CLAUDE_GLOBAL_SKILL_DIR]
  ),
  antigravity: skillDirs([DEFAULT_PROJECT_SKILL_DIR], ['~/.gemini/antigravity/skills']),
  'antigravity-cli': skillDirs([DEFAULT_PROJECT_SKILL_DIR], ['~/.gemini/antigravity-cli/skills']),
  astrbot: skillDirs(['data/skills'], ['~/.astrbot/data/skills']),
  auggie: skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.augment/skills', CLAUDE_PROJECT_SKILL_DIR],
    ['~/.augment/skills', DEFAULT_AGENTS_GLOBAL_SKILL_DIR]
  ),
  augment: skillDirs(['.augment/skills'], ['~/.augment/skills']),
  autohand: skillDirs([DEFAULT_PROJECT_SKILL_DIR, '.autohand/skills'], ['~/.autohand/skills']),
  'autohand-code': skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.autohand/skills'],
    ['~/.autohand/skills']
  ),
  bob: skillDirs(['.bob/skills'], ['~/.bob/skills']),
  claude: skillDirs([CLAUDE_PROJECT_SKILL_DIR], [CLAUDE_GLOBAL_SKILL_DIR]),
  'claude-acp': skillDirs([CLAUDE_PROJECT_SKILL_DIR], [CLAUDE_GLOBAL_SKILL_DIR]),
  'claude-code': skillDirs([CLAUDE_PROJECT_SKILL_DIR], [CLAUDE_GLOBAL_SKILL_DIR]),
  'claude-p': skillDirs([CLAUDE_PROJECT_SKILL_DIR], [CLAUDE_GLOBAL_SKILL_DIR]),
  cline: skillDirs(
    ['.cline/skills', '.clinerules/skills', CLAUDE_PROJECT_SKILL_DIR],
    ['~/.cline/skills']
  ),
  'codearts-agent': skillDirs(['.codeartsdoer/skills'], ['~/.codeartsdoer/skills']),
  codebuddy: skillDirs(['.codebuddy/skills'], ['~/.codebuddy/skills']),
  'codebuddy-code': skillDirs(['.codebuddy/skills'], ['~/.codebuddy/skills']),
  codemaker: skillDirs(['.codemaker/skills'], ['~/.codemaker/skills']),
  codestudio: skillDirs(['.codestudio/skills'], ['~/.codestudio/skills']),
  codex: skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR],
    [DEFAULT_AGENTS_GLOBAL_SKILL_DIR],
    [CODEX_SYSTEM_SKILL_DIR]
  ),
  'codex-acp': skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR],
    [DEFAULT_AGENTS_GLOBAL_SKILL_DIR],
    [CODEX_SYSTEM_SKILL_DIR]
  ),
  'command-code': skillDirs(['.commandcode/skills'], ['~/.commandcode/skills']),
  continue: skillDirs(['.continue/skills'], ['~/.continue/skills']),
  cortex: skillDirs([DEFAULT_PROJECT_SKILL_DIR, '.cortex/skills'], ['~/.snowflake/cortex/skills']),
  'cortex-code': skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.cortex/skills'],
    ['~/.snowflake/cortex/skills']
  ),
  crush: skillDirs(['.crush/skills'], ['~/.config/crush/skills']),
  cursor: skillDirs([DEFAULT_PROJECT_SKILL_DIR], ['~/.cursor/skills']),
  deepagents: skillDirs([], []),
  /* `dsh-skill-filesystem`, mounted by the standard and code presets with no
     roots configured, discovers the project and user defaults. `minimal` and
     `cordis` differ, which this per-agent table cannot express. */
  deepseek: skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.dsh/skills'],
    ['~/.dsh/skills', DEFAULT_AGENTS_GLOBAL_SKILL_DIR]
  ),
  devin: skillDirs(
    ['.devin/skills', '.windsurf/skills'],
    [DEFAULT_AGENTS_GLOBAL_SKILL_DIR, '~/.config/devin/skills']
  ),
  dexto: skillDirs([DEFAULT_PROJECT_SKILL_DIR], ['~/.agents/skills']),
  droid: skillDirs(['.factory/skills', FACTORY_COMPAT_PROJECT_SKILL_DIR], ['~/.factory/skills']),
  eve: skillDirs(['agent/skills'], []),
  factory: skillDirs(['.factory/skills', FACTORY_COMPAT_PROJECT_SKILL_DIR], ['~/.factory/skills']),
  'factory-droid': skillDirs(
    ['.factory/skills', FACTORY_COMPAT_PROJECT_SKILL_DIR],
    ['~/.factory/skills']
  ),
  'fast-agent': skillDirs([DEFAULT_PROJECT_SKILL_DIR], []),
  firebender: skillDirs([DEFAULT_PROJECT_SKILL_DIR], ['~/.firebender/skills']),
  forgecode: skillDirs(['.forge/skills'], ['~/.forge/skills']),
  gemini: skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.gemini/skills'],
    ['~/.gemini/skills', DEFAULT_AGENTS_GLOBAL_SKILL_DIR]
  ),
  'gemini-cli': skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.gemini/skills'],
    ['~/.gemini/skills', DEFAULT_AGENTS_GLOBAL_SKILL_DIR]
  ),
  'github-copilot': skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.github/skills', CLAUDE_PROJECT_SKILL_DIR],
    ['~/.copilot/skills', DEFAULT_AGENTS_GLOBAL_SKILL_DIR]
  ),
  'github-copilot-cli': skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.github/skills', CLAUDE_PROJECT_SKILL_DIR],
    ['~/.copilot/skills', DEFAULT_AGENTS_GLOBAL_SKILL_DIR]
  ),
  goose: skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.goose/skills'],
    ['~/.config/goose/skills', DEFAULT_AGENTS_GLOBAL_SKILL_DIR]
  ),
  /* Grok's skill roots are `.grok`, `.agents`, and — on by default — the
     `.claude` and `.cursor` compat roots, at every tier. */
  grok: skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.grok/skills', CLAUDE_PROJECT_SKILL_DIR, '.cursor/skills'],
    ['~/.grok/skills', DEFAULT_AGENTS_GLOBAL_SKILL_DIR, CLAUDE_GLOBAL_SKILL_DIR, '~/.cursor/skills']
  ),
  'hermes-agent': skillDirs(['.hermes/skills'], ['~/.hermes/skills']),
  iflow: skillDirs(['.iflow/skills'], ['~/.iflow/skills']),
  'iflow-cli': skillDirs(['.iflow/skills'], ['~/.iflow/skills']),
  'inference-sh': skillDirs(['.inferencesh/skills'], ['~/.inferencesh/skills']),
  jazz: skillDirs(['.jazz/skills'], ['~/.jazz/skills']),
  junie: skillDirs(['.junie/skills'], ['~/.junie/skills']),
  kilo: skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.kilo/skills', '.kilocode/skills'],
    ['~/.kilo/skills', '~/.kilocode/skills']
  ),
  'kilo-code': skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.kilo/skills', '.kilocode/skills'],
    ['~/.kilo/skills', '~/.kilocode/skills']
  ),
  kiro: skillDirs(['.kiro/skills'], ['~/.kiro/skills']),
  'kiro-cli': skillDirs(['.kiro/skills'], ['~/.kiro/skills']),
  kimi: skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.kimi-code/skills'],
    ['~/.kimi-code/skills', DEFAULT_AGENTS_GLOBAL_SKILL_DIR]
  ),
  'kimi-code': skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.kimi-code/skills'],
    ['~/.kimi-code/skills', DEFAULT_AGENTS_GLOBAL_SKILL_DIR]
  ),
  'kimi-code-cli': skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.kimi-code/skills'],
    ['~/.kimi-code/skills', DEFAULT_AGENTS_GLOBAL_SKILL_DIR]
  ),
  kode: skillDirs(['.kode/skills'], ['~/.kode/skills']),
  lingma: skillDirs(['.lingma/skills'], ['~/.lingma/skills']),
  loaf: skillDirs([DEFAULT_PROJECT_SKILL_DIR], [DEFAULT_AGENTS_GLOBAL_SKILL_DIR]),
  mcpjam: skillDirs(['.mcpjam/skills'], ['~/.mcpjam/skills']),
  'mistral-vibe': skillDirs(['.vibe/skills'], ['~/.vibe/skills', DEFAULT_AGENTS_GLOBAL_SKILL_DIR]),
  moxby: skillDirs(['.moxby/skills'], ['~/.moxby/skills']),
  mux: skillDirs(['.mux/skills'], ['~/.mux/skills']),
  neovate: skillDirs(['.neovate/skills'], ['~/.neovate/skills']),
  ona: skillDirs(['.ona/skills'], ['~/.ona/skills']),
  openclaw: skillDirs(['skills'], ['~/.openclaw/skills']),
  opencode: skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.opencode/skills', CLAUDE_PROJECT_SKILL_DIR],
    ['~/.config/opencode/skills', CLAUDE_GLOBAL_SKILL_DIR, DEFAULT_AGENTS_GLOBAL_SKILL_DIR]
  ),
  openhands: skillDirs(['.openhands/skills'], ['~/.openhands/skills']),
  pi: skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.pi/skills'],
    ['~/.pi/agent/skills', DEFAULT_AGENTS_GLOBAL_SKILL_DIR]
  ),
  'pi-acp': skillDirs(
    [DEFAULT_PROJECT_SKILL_DIR, '.pi/skills'],
    ['~/.pi/agent/skills', DEFAULT_AGENTS_GLOBAL_SKILL_DIR]
  ),
  pochi: skillDirs(['.pochi/skills'], ['~/.pochi/skills']),
  promptscript: skillDirs([DEFAULT_PROJECT_SKILL_DIR], []),
  qoder: skillDirs(['.qoder/skills'], ['~/.qoder/skills']),
  'qoder-cn': skillDirs(['.qoder/skills'], ['~/.qoder-cn/skills']),
  qwen: skillDirs(['.qwen/skills'], ['~/.qwen/skills']),
  'qwen-code': skillDirs(['.qwen/skills'], ['~/.qwen/skills']),
  reasonix: skillDirs(['.reasonix/skills'], ['~/.reasonix/skills']),
  replit: skillDirs([DEFAULT_PROJECT_SKILL_DIR], [DEFAULT_GLOBAL_SKILL_DIR]),
  roo: skillDirs(['.roo/skills'], ['~/.roo/skills']),
  rovodev: skillDirs(['.rovodev/skills'], ['~/.rovodev/skills']),
  tabnine: skillDirs(['.tabnine/agent/skills'], ['~/.tabnine/agent/skills']),
  'tabnine-cli': skillDirs(['.tabnine/agent/skills'], ['~/.tabnine/agent/skills']),
  terramind: skillDirs(['.terramind/skills'], ['~/.terramind/skills']),
  tinycloud: skillDirs(['.tinycloud/skills'], ['~/.tinycloud/skills']),
  trae: skillDirs(['.trae/skills'], ['~/.trae/skills']),
  'trae-cn': skillDirs(['.trae/skills'], ['~/.trae-cn/skills']),
  universal: skillDirs([DEFAULT_PROJECT_SKILL_DIR], [DEFAULT_GLOBAL_SKILL_DIR]),
  warp: skillDirs([DEFAULT_PROJECT_SKILL_DIR], [DEFAULT_AGENTS_GLOBAL_SKILL_DIR]),
  windsurf: skillDirs(['.windsurf/skills'], ['~/.codeium/windsurf/skills']),
  zed: skillDirs([DEFAULT_PROJECT_SKILL_DIR], [DEFAULT_AGENTS_GLOBAL_SKILL_DIR]),
  zencoder: skillDirs(['.zencoder/skills'], ['~/.zencoder/skills']),
  zenflow: skillDirs(['.zencoder/skills'], ['~/.zencoder/skills']),
};

/* Cache-invalidation version for the SWR skills cache. Bump when the skill dir
   mapping OR the cached `ProjectSkill` shape changes, so stale entries are
   discarded and re-fetched. v4: cache keys are user-scoped and skill content is
   budgeted/capped before storage to avoid carrying pre-budget oversized entries.
   v5: scanner includes one extra catalog-layout level under skill container dirs.
   v6: provider global dirs align with verified ~/.agents/skills aliases.
   v7: project `.agents/skills` is provider-specific, not a universal ACP fallback.
   v8: local/global scans include absolute SKILL.md paths for prompt expansion.
   v9: home scan also surfaces agent built-in `system` skills (codex
   `~/.codex/skills/.system`) under the new `'system'` scope.
   v10: grok is registered, and pi/kimi global dirs match their engines
   (`~/.agents/skills` for both, `.kimi-code` for kimi's brand dirs). */
export const KNOWN_SKILL_DIRS_VERSION = 10;

export const DEFAULT_PROJECT_SKILLS_CONTENT_BUDGET_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PROJECT_SKILLS_RESULT_MAX_SKILLS = 5_000;

export const ALL_KNOWN_PROJECT_SKILL_DIRS: string[] = [
  ...new Set([
    'skills',
    'skills/.curated',
    'skills/.experimental',
    'skills/.system',
    DEFAULT_PROJECT_SKILL_DIR,
    ...Object.values(ACP_SKILL_DIRS_BY_AGENT_TYPE).flatMap((value) => value.projectDirs),
  ]),
].sort((left, right) => left.localeCompare(right));

export const ALL_KNOWN_GLOBAL_SKILL_DIRS: string[] = [
  ...new Set([
    DEFAULT_GLOBAL_SKILL_DIR,
    ...Object.values(ACP_SKILL_DIRS_BY_AGENT_TYPE).flatMap((value) => value.globalDirs),
  ]),
].sort((left, right) => left.localeCompare(right));

/** Home-relative dirs holding agents' built-in (system) skills. Scanned during
   the machine home scan and surfaced under the `'system'` scope, distinct from
   the user-authored `'global'` skills. */
export const ALL_KNOWN_SYSTEM_SKILL_DIRS: string[] = [
  ...new Set(Object.values(ACP_SKILL_DIRS_BY_AGENT_TYPE).flatMap((value) => value.systemDirs)),
].sort((left, right) => left.localeCompare(right));

export type ProjectSkillScope = 'project' | 'global' | 'system';

const PROJECT_SKILL_SCOPE_ORDER: Record<ProjectSkillScope, number> = {
  project: 0,
  global: 1,
  system: 2,
};

/** Stable display order for skill scopes: project, then global, then system. */
export function compareProjectSkillScope(
  left: ProjectSkillScope,
  right: ProjectSkillScope
): number {
  return PROJECT_SKILL_SCOPE_ORDER[left] - PROJECT_SKILL_SCOPE_ORDER[right];
}

export type ProjectSkill = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  relativePath: string;
  /** Absolute SKILL.md path when known. Local/global scanners provide this for
     prompt expansion; GitHub scans intentionally omit it. */
  absolutePath?: string;
  isSymlink: boolean;
  /** When `isSymlink`, the project-relative directory the symlink resolves to
     (the canonical location of the real SKILL.md). Surfaced as the "original
     path" tooltip on the symlink badge. */
  symlinkTarget?: string;
  /** The SKILL.md Markdown body (frontmatter stripped). Read during scanning
     and surfaced in the skill detail view. Omitted when the body is empty or
     when the aggregate list response budget is exhausted. */
  content?: string;
};

export type ProjectSkillGroup = {
  scope: ProjectSkillScope;
  dir: string;
  skills: ProjectSkill[];
  truncated: boolean;
  skippedExternalSymlinks?: number;
  error?: string;
};

export type ProjectSkillsResult = {
  groups: ProjectSkillGroup[];
  contentFingerprint?: string;
};

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid project skills ${label}: ${value}`);
  }
}

export function applyProjectSkillsResultBudget(
  groups: readonly ProjectSkillGroup[],
  options: {
    maxContentBytes?: number;
    maxSkills?: number;
  } = {}
): ProjectSkillGroup[] {
  const maxContentBytes = options.maxContentBytes ?? DEFAULT_PROJECT_SKILLS_CONTENT_BUDGET_BYTES;
  const maxSkills = options.maxSkills ?? DEFAULT_PROJECT_SKILLS_RESULT_MAX_SKILLS;
  assertNonNegativeSafeInteger(maxContentBytes, 'content budget');
  assertNonNegativeSafeInteger(maxSkills, 'skill count budget');

  let remainingContentBytes = maxContentBytes;
  let remainingSkills = maxSkills;
  return groups.map((group) => {
    let groupChanged = false;
    let skillsTruncated = false;
    const skills: ProjectSkill[] = [];
    for (const skill of group.skills) {
      if (remainingSkills === 0) {
        groupChanged = true;
        skillsTruncated = true;
        continue;
      }
      remainingSkills -= 1;
      if (skill.content === undefined) {
        skills.push(skill);
        continue;
      }
      const contentBytes = utf8ByteLength(skill.content);
      if (contentBytes > remainingContentBytes) {
        groupChanged = true;
        const { content: _content, ...metadataOnlySkill } = skill;
        skills.push(metadataOnlySkill);
        continue;
      }
      remainingContentBytes -= contentBytes;
      skills.push(skill);
    }
    return groupChanged
      ? { ...group, skills, truncated: group.truncated || skillsTruncated }
      : group;
  });
}

export type ProjectSkillFrontmatter = {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  metadata?: {
    version?: string;
    author?: string;
  };
};

export function getSkillScanCandidateDirs(): string[] {
  return ALL_KNOWN_PROJECT_SKILL_DIRS;
}

/** Whether the table has an entry at all. An entry mapping to no directory
   (`deepagents`) is registered: it asserts the agent reads none. */
export function isRegisteredSkillAgentType(agentType: string): boolean {
  return Object.hasOwn(ACP_SKILL_DIRS_BY_AGENT_TYPE, agentType);
}

export function getRegisteredSkillDirs(
  agents: ReadonlyArray<{ cliType: AgentConfigCliType; agentType: string }>
): Set<string> {
  const projectDirs = new Set<string>();
  for (const agent of agents) {
    const mapping = ACP_SKILL_DIRS_BY_AGENT_TYPE[agent.agentType];
    if (!mapping) {
      continue;
    }
    for (const dir of mapping.projectDirs) {
      projectDirs.add(dir);
    }
  }
  return projectDirs;
}

export function getRegisteredGlobalSkillDirs(
  agents: ReadonlyArray<{ cliType: AgentConfigCliType; agentType: string }>
): Set<string> {
  const globalDirs = new Set<string>();
  for (const agent of agents) {
    const mapping = ACP_SKILL_DIRS_BY_AGENT_TYPE[agent.agentType];
    if (!mapping) {
      continue;
    }
    for (const dir of mapping.globalDirs) {
      globalDirs.add(dir);
    }
  }
  return globalDirs;
}

export function getRegisteredSystemSkillDirs(
  agents: ReadonlyArray<{ cliType: AgentConfigCliType; agentType: string }>
): Set<string> {
  const systemDirs = new Set<string>();
  for (const agent of agents) {
    const mapping = ACP_SKILL_DIRS_BY_AGENT_TYPE[agent.agentType];
    if (!mapping) {
      continue;
    }
    for (const dir of mapping.systemDirs) {
      systemDirs.add(dir);
    }
  }
  return systemDirs;
}

function normalizeFrontmatterValue(rawValue: string): string {
  const value = rawValue.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

function setFrontmatterValue(target: ProjectSkillFrontmatter, key: string, value: string): void {
  const normalizedValue = normalizeFrontmatterValue(value);
  if (normalizedValue.length === 0) {
    return;
  }

  if (key === 'name') {
    target.name = normalizedValue;
    return;
  }
  if (key === 'description') {
    target.description = normalizedValue;
    return;
  }
  if (key === 'version') {
    target.version = normalizedValue;
    return;
  }
  if (key === 'author') {
    target.author = normalizedValue;
    return;
  }
  if (key === 'metadata.version') {
    target.metadata = { ...target.metadata, version: normalizedValue };
    return;
  }
  if (key === 'metadata.author') {
    target.metadata = { ...target.metadata, author: normalizedValue };
  }
}

export function parseSkillFrontmatter(markdown: string): ProjectSkillFrontmatter {
  const normalized = markdown.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return {};
  }

  const newline = normalized.startsWith('---\r\n') ? '\r\n' : '\n';
  const startLength = 3 + newline.length;
  const endMarker = `${newline}---`;
  const endIndex = normalized.indexOf(endMarker, startLength);
  if (endIndex === -1) {
    throw new Error('SKILL.md frontmatter is missing a closing marker.');
  }

  const frontmatter = normalized.slice(startLength, endIndex);
  const result: ProjectSkillFrontmatter = {};
  let currentParent: string | null = null;

  for (const rawLine of frontmatter.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    if (/^\s/.test(rawLine)) {
      if (currentParent !== 'metadata') {
        continue;
      }
      const nestedMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!nestedMatch) {
        if (line.startsWith('- ')) {
          continue;
        }
        throw new Error(`Invalid metadata frontmatter line: ${line}`);
      }
      const nestedKey = nestedMatch[1];
      if (nestedKey === undefined) {
        throw new Error(`Invalid metadata frontmatter line: ${line}`);
      }
      const nestedValue = nestedMatch[2] ?? '';
      setFrontmatterValue(result, `metadata.${nestedKey}`, nestedValue);
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) {
      throw new Error(`Invalid SKILL.md frontmatter line: ${line}`);
    }

    const key = match[1];
    if (key === undefined) {
      throw new Error(`Invalid SKILL.md frontmatter line: ${line}`);
    }
    const value = match[2] ?? '';
    currentParent = value.trim() === '' ? key : null;
    setFrontmatterValue(result, key, value);
  }

  return result;
}

export function extractProjectSkillMetadata(
  markdown: string,
  fallbackName: string
): Pick<ProjectSkill, 'name' | 'description' | 'version' | 'author'> {
  const frontmatter = parseSkillFrontmatter(markdown);
  const name = frontmatter.name?.trim() || fallbackName;
  const description = frontmatter.description?.trim();
  const version = frontmatter.version?.trim() || frontmatter.metadata?.version?.trim();
  const author = frontmatter.author?.trim() || frontmatter.metadata?.author?.trim();

  return {
    name,
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    ...(author ? { author } : {}),
  };
}

/** Basename of a `/`-separated project-relative skill dir (no trailing slash). */
function skillDirBasename(dir: string): string {
  const index = dir.lastIndexOf('/');
  return index === -1 ? dir : dir.slice(index + 1);
}

/**
 * Assemble a {@link ProjectSkill} from a resolved SKILL.md. Centralizes the
 * `id` / `idSegment` rule and metadata extraction so the three scanners (local
 * fs, GitHub tree, GitHub contents) produce byte-identical skill records — the
 * stable `id` is what the SWR cache keys and mention tokens agree on, so it must
 * not drift between sources. Callers supply only the I/O-derived inputs
 * (`relativePath` / `symlinkTarget` are computed per transport).
 */
export function buildProjectSkill(args: {
  groupDir: string;
  displaySkillDir: string;
  markdown: string;
  relativePath: string;
  absolutePath?: string;
  isSymlink: boolean;
  symlinkTarget?: string;
}): ProjectSkill {
  const fallbackName =
    skillDirBasename(args.displaySkillDir) || skillDirBasename(args.groupDir) || args.groupDir;
  const idSegment = args.displaySkillDir === args.groupDir ? 'SKILL.md' : fallbackName;
  const content = getSkillMarkdownBody(args.markdown);
  return {
    id: `${args.groupDir}/${idSegment}`,
    relativePath: args.relativePath,
    ...(args.absolutePath ? { absolutePath: args.absolutePath } : {}),
    isSymlink: args.isSymlink,
    ...(args.symlinkTarget ? { symlinkTarget: args.symlinkTarget } : {}),
    ...(content ? { content } : {}),
    ...extractProjectSkillMetadata(args.markdown, fallbackName),
  };
}

/** The Markdown body after the leading `---` frontmatter block (if present). */
export function getSkillMarkdownBody(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return normalized.trim();
  }
  const newline = normalized.startsWith('---\r\n') ? '\r\n' : '\n';
  const startLength = 3 + newline.length;
  const endIndex = normalized.indexOf(`${newline}---`, startLength);
  if (endIndex === -1) {
    return normalized.trim();
  }
  const lineEnd = normalized.indexOf('\n', endIndex + newline.length + 3);
  return lineEnd === -1 ? '' : normalized.slice(lineEnd + 1).trim();
}
