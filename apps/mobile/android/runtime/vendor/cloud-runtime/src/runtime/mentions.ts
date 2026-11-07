import { projectControl } from './local-projects';
import type { MachineContext } from './files';
import type {
  MentionCatalog,
  MentionCategory,
  MentionItem,
} from '../models/mentions';

// Public Lody local-project/list-skills scan roots. Keep this wire data local:
// @lody/shared's root also imports Node-only modules that cannot run in the WebView.
const skillDirs: string[] = [
  '.adal/skills',
  '.agent/skills',
  '.agents/skills',
  '.aider-desk/skills',
  '.augment/skills',
  '.autohand/skills',
  '.bob/skills',
  '.claude/skills',
  '.cline/skills',
  '.clinerules/skills',
  '.codeartsdoer/skills',
  '.codebuddy/skills',
  '.codemaker/skills',
  '.codestudio/skills',
  '.commandcode/skills',
  '.continue/skills',
  '.cortex/skills',
  '.crush/skills',
  '.cursor/skills',
  '.devin/skills',
  '.dsh/skills',
  '.factory/skills',
  '.forge/skills',
  '.gemini/skills',
  '.github/skills',
  '.goose/skills',
  '.grok/skills',
  '.hermes/skills',
  '.iflow/skills',
  '.inferencesh/skills',
  '.jazz/skills',
  '.junie/skills',
  '.kilo/skills',
  '.kilocode/skills',
  '.kimi-code/skills',
  '.kiro/skills',
  '.kode/skills',
  '.lingma/skills',
  '.mcpjam/skills',
  '.moxby/skills',
  '.mux/skills',
  '.neovate/skills',
  '.ona/skills',
  '.opencode/skills',
  '.openhands/skills',
  '.pi/skills',
  '.pochi/skills',
  '.qoder/skills',
  '.qwen/skills',
  '.reasonix/skills',
  '.roo/skills',
  '.rovodev/skills',
  '.tabnine/agent/skills',
  '.terramind/skills',
  '.tinycloud/skills',
  '.trae/skills',
  '.vibe/skills',
  '.windsurf/skills',
  '.zencoder/skills',
  'agent/skills',
  'data/skills',
  'skills',
  'skills/.curated',
  'skills/.experimental',
  'skills/.system',
];
const maxFiles = 20000;

type Context = MachineContext & {
  localProjectId?: string;
  repoFullName?: string;
  sessionId?: string;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const safeText = (value: unknown, limit = 4096): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= limit &&
  !/[\x00-\x1f\x7f]/.test(value);
const relativePath = (value: unknown): value is string =>
  safeText(value) &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !value.split('/').some((part) => !part || part === '.' || part === '..');

export function fileMentions(value: Record<string, unknown>): MentionCatalog {
  if (!Array.isArray(value.paths) || typeof value.truncated !== 'boolean')
    throw new Error('invalid_file_list');
  const items = new Map<string, MentionItem>();
  let incomplete = false;
  let budget = 2 * 1024 * 1024;
  let truncated = value.truncated || value.paths.length > maxFiles;
  const add = (item: MentionItem) => {
    if (items.has(item.path)) return true;
    budget -= new TextEncoder().encode(JSON.stringify(item)).length;
    if (budget < 0 || items.size >= 40000) {
      truncated = true;
      return false;
    }
    items.set(item.path, item);
    return true;
  };
  files: for (const path of value.paths.slice(0, maxFiles)) {
    if (!relativePath(path)) {
      incomplete = true;
      continue;
    }
    const parts = path.split('/');
    if (parts.length > 128) {
      incomplete = true;
      continue;
    }
    // Parents come first so a bounded catalog never strands a file below a missing folder.
    for (let depth = 1; depth <= parts.length; depth++) {
      const current = parts.slice(0, depth).join('/');
      if (
        !add({
          path: current,
          name: parts[depth - 1],
          kind: depth === parts.length ? 'file' : 'directory',
          subtitle: parts.slice(0, depth - 1).join('/'),
          insertText: `@${/\s|"/.test(current) ? JSON.stringify(current) : current}`,
        })
      )
        break files;
    }
  }
  return {
    items: [...items.values()],
    truncated,
    incomplete,
  };
}

export function skillMentions(
  values: Record<string, unknown>[],
): MentionCatalog {
  const items = new Map<string, MentionItem>();
  let truncated = false,
    incomplete = false;
  let budget = 2 * 1024 * 1024;
  const groups = values.flatMap((value) => {
    if (!Array.isArray(value.groups)) throw new Error('invalid_skill_list');
    return value.groups.map(object);
  });
  const scopeRank: Record<string, number> = {
    project: 0,
    global: 1,
    system: 2,
  };
  groups.sort(
    (a, b) =>
      (scopeRank[String(a.scope)] ?? 3) - (scopeRank[String(b.scope)] ?? 3) ||
      String(a.dir ?? '').localeCompare(String(b.dir ?? '')),
  );
  for (const group of groups) {
    if (!Array.isArray(group.skills)) throw new Error('invalid_skill_group');
    truncated ||= group.truncated === true;
    incomplete ||= !!group.error;
    for (const rawSkill of group.skills) {
      const skill = object(rawSkill);
      const path =
        group.scope === 'project'
          ? skill.relativePath
          : (skill.absolutePath ?? skill.relativePath);
      if (
        !safeText(path) ||
        !(
          path.startsWith('/') ||
          path.startsWith('~/') ||
          relativePath(path)
        ) ||
        !safeText(skill.name, 256)
      ) {
        incomplete = true;
        continue;
      }
      if (!path.toLowerCase().endsWith('/skill.md')) {
        incomplete = true;
        continue;
      }
      budget -= new TextEncoder().encode(
        JSON.stringify({
          path,
          name: skill.name,
          description: skill.description,
        }),
      ).length;
      if (budget < 0 || items.size >= 5000) {
        truncated = true;
        break;
      }
      const name = skill.name.trim();
      let token = name;
      if (!name || /\s/.test(name))
        token = String(skill.relativePath ?? path)
          .replace(/\/SKILL\.md$/i, '')
          .split('/')
          .filter(Boolean)
          .pop()!
          .replace(/\s+/g, '-');
      if (items.has(token)) continue;
      items.set(token, {
        path,
        name: skill.name,
        kind: 'skill',
        subtitle: safeText(skill.description, 4096)
          ? skill.description
          : String(group.dir ?? ''),
        insertText: `$${token}`,
      });
    }
  }
  return { items: [...items.values()], truncated, incomplete };
}

export async function mentionCatalog(
  ctx: Context,
  category: MentionCategory,
  userId: string,
): Promise<MentionCatalog> {
  const request = (args: Record<string, unknown>) =>
    projectControl(
      ctx.workspaceId,
      ctx.machineId,
      { ...args, requestedByUserId: userId },
      ctx.getGrant,
      ctx.signal,
    );
  if (category === 'file') {
    if (ctx.localProjectId)
      return fileMentions(
        await request({
          type: 'local-project/list-files',
          localProjectId: ctx.localProjectId,
          maxFiles,
        }),
      );
    if (ctx.repoFullName && ctx.sessionId)
      return fileMentions(
        await request({
          type: 'worktree/list-files',
          repoFullName: ctx.repoFullName,
          sessionId: ctx.sessionId,
          maxFiles,
        }),
      );
    return { items: [], truncated: false, incomplete: false };
  }
  if (category !== 'skill') throw new Error('invalid_mention_category');
  const requests = [request({ type: 'local-project/list-global-skills' })];
  if (ctx.localProjectId)
    requests.push(
      request({
        type: 'local-project/list-skills',
        localProjectId: ctx.localProjectId,
        skillDirs,
      }),
    );
  const results = await Promise.allSettled(requests);
  const good = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  if (!good.length) throw new Error('skills_unavailable');
  const result = skillMentions(good);
  return {
    ...result,
    incomplete: result.incomplete || good.length !== requests.length,
  };
}

export function sessionMentions(
  sessions: import('../models/catalog').Session[],
  projects: import('../models/catalog').Project[],
  currentId?: string,
): MentionCatalog {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const items = sessions
    .filter((session) => session.id !== currentId && safeText(session.id, 256))
    .sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) ||
        (b.lastMessageAt ?? (Date.parse(b.createdAt) || 0)) -
          (a.lastMessageAt ?? (Date.parse(a.createdAt) || 0)),
    )
    .map((session) => ({
      path: session.id,
      name: session.title,
      kind: 'session' as const,
      subtitle: names.get(session.projectId) ?? '',
      insertText: `@session:${session.id}`,
    }));
  return { items, truncated: false, incomplete: false };
}

export function commandMentions(commands: unknown): MentionCatalog {
  const items = new Map<string, MentionItem>();
  for (const raw of Array.isArray(commands) ? commands : []) {
    const command = object(raw);
    if (!safeText(command.name, 128) || !/^[\w:.-]+$/.test(command.name))
      continue;
    items.set(command.name, {
      path: command.name,
      name: command.name,
      kind: 'cmd',
      subtitle: safeText(command.description, 4096) ? command.description : '',
      insertText: `/${command.name}`,
    });
  }
  return { items: [...items.values()], truncated: false, incomplete: false };
}
