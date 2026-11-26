import { LODY_PROTOCOLS, SESSION_LINK_SCHEMES } from './session-link-schemes.mjs';
import { encodeTodayUserId, parseTodayDate } from './today-types';
export {
  LODY_PROTOCOLS,
  SESSION_LINK_SCHEMES,
  INSTALLATION_LINK_SCHEMES,
} from './session-link-schemes.mjs';

/** Public resource links are independent of the installed desktop channel. */
export type SessionLink = {
  sessionId: string;
  workspaceId?: string;
  /** Legacy read compatibility only; new links address this ID directly. */
  tabSessionId?: string;
};

const ID = /^[A-Za-z0-9_-]+$/u;
const SCHEMES = new Set(SESSION_LINK_SCHEMES.map((scheme) => `${scheme}:`));

export function buildSessionLink(target: SessionLink): string {
  for (const value of [target.sessionId, target.workspaceId, target.tabSessionId]) {
    if (value !== undefined && !ID.test(value)) throw new Error('Invalid session link identifier');
  }
  const query = new URLSearchParams();
  if (target.workspaceId) query.set('workspace', target.workspaceId);
  const sessionId = target.tabSessionId ?? target.sessionId;
  const url = `${LODY_PROTOCOLS.resource}://session/${sessionId}${query.size ? `?${query}` : ''}`;
  if (url.length > 8192) throw new Error('Session link is too long');
  return url;
}

/** Read old transcripts without ever registering the generic session scheme. */
export function parseSessionLink(raw: string): SessionLink | null {
  if (raw.length > 8192 || /[\s\\%]/u.test(raw)) return null;
  const legacy = /^session:\/\/([A-Za-z0-9_-]+)\/?$/u.exec(raw);
  if (legacy) return { sessionId: legacy[1]! };
  // Reject path normalization (e.g. /other/../id) before URL can erase it.
  if (!/^[a-zA-Z.-]+:\/\/session\/[A-Za-z0-9_-]+(?:\?[^#]*)?$/u.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    !SCHEMES.has(url.protocol) ||
    url.hostname !== 'session' ||
    url.port ||
    url.username ||
    url.password
  )
    return null;
  const sessionId = url.pathname.slice(1);
  if (!ID.test(sessionId)) return null;
  for (const key of url.searchParams.keys()) {
    if (key !== 'workspace' && key !== 'tab') return null;
    if (url.searchParams.getAll(key).length !== 1 || !ID.test(url.searchParams.get(key) ?? ''))
      return null;
  }
  return {
    sessionId,
    ...(url.searchParams.has('workspace')
      ? { workspaceId: url.searchParams.get('workspace')! }
      : {}),
    ...(url.searchParams.has('tab') ? { tabSessionId: url.searchParams.get('tab')! } : {}),
  };
}

/** MCP references cannot select a different authorized workspace. */
export function resolveSessionLinkId(raw: string, workspaceId: string): string {
  const link = parseSessionLink(raw);
  if (!link) {
    if (!ID.test(raw)) throw new Error('Invalid session reference');
    return raw;
  }
  if (link.workspaceId && link.workspaceId !== workspaceId) {
    throw new Error('Session link belongs to a different workspace');
  }
  // A bare session reference is unambiguous; tab relationships require a catalog.
  if (link.tabSessionId) throw new Error('Use the child session ID directly for MCP requests');
  return link.sessionId;
}

/** A member's Today page for one day (specs/today-outline.md). */
export type TodayLink = { userId: string; date: string; workspaceId: string };

/**
 * `lody://today/<encodeURIComponent(userId)>/<YYYY-MM-DD>?workspace=<id>`.
 * Unlike session links the user segment may hold `%XX` (local ids contain `:`),
 * but only in its canonical encoding, so one page has exactly one link.
 */
export function parseTodayLink(raw: string): TodayLink | null {
  if (raw.length > 8192 || /[\s\\]/u.test(raw)) return null;
  const match =
    /^([a-zA-Z.-]+):\/\/today\/([A-Za-z0-9_.~%-]+)\/(\d{4}-\d{2}-\d{2})\?workspace=([A-Za-z0-9_-]+)$/u.exec(
      raw
    );
  if (!match || !SCHEMES.has(`${match[1]}:`)) return null;
  const [, , encodedUser, date, workspaceId] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  let userId: string;
  try {
    userId = decodeURIComponent(encodedUser);
  } catch {
    return null;
  }
  if (!userId || /^\.+$/u.test(userId) || encodeTodayUserId(userId) !== encodedUser) return null;
  if (!parseTodayDate(date)) return null;
  return { userId, date, workspaceId };
}

export const APP_SETTINGS_LINK_TABS = [
  'account',
  'preferences',
  'appearance',
  'keyboard-shortcuts',
  'workspace',
  'shares',
  'people',
  'machines',
  'agents',
  'memory',
  'agent-roles',
  'prompt-shortcuts',
  'mcp',
  'projects',
  'github',
  'ai-usage',
  'billing',
  'data',
  'about',
] as const;

export type AppSettingsLinkTab = (typeof APP_SETTINGS_LINK_TABS)[number];

export const AGENT_CREATE_BUILTIN_TARGETS = [
  'codex',
  'claude',
  'kimi',
  'deepseek',
  'pi',
  'devin',
  'grok',
  'antigravity',
  'bub',
  'dimcode',
] as const;

export const AGENT_CREATE_PRESET_TARGETS = [
  'glm-over-claude-code',
  'mimo-over-claude-code',
  'minimax-over-claude-code',
] as const;

export const PROJECT_LINK_PAGES = [
  'general',
  'worktree',
  'skills',
  'defaultMcp',
  'conversations',
] as const;

export type ProjectLinkPage = (typeof PROJECT_LINK_PAGES)[number];

export type AgentCreateLinkTarget =
  | { kind: 'builtin'; agentType: (typeof AGENT_CREATE_BUILTIN_TARGETS)[number] }
  | { kind: 'preset'; presetId: (typeof AGENT_CREATE_PRESET_TARGETS)[number] }
  | { kind: 'custom' }
  | { kind: 'registry'; agentType: string };

export type AppActionLink =
  | {
      kind: 'settings';
      tab: 'agents';
      workspaceId?: string;
      machineId?: string;
      create?: AgentCreateLinkTarget;
      configId?: string;
    }
  | {
      kind: 'settings';
      tab: 'agent-roles';
      workspaceId?: string;
      machineId?: string;
      create?: true;
      roleId?: string;
    }
  | {
      kind: 'settings';
      tab: 'mcp';
      workspaceId?: string;
      create?: true;
      serverId?: string;
    }
  | {
      kind: 'settings';
      tab: 'projects';
      workspaceId?: string;
      machineId?: string;
      add?: 'local' | 'group';
      repoFullName?: string;
      localProjectId?: string;
      page?: ProjectLinkPage;
    }
  | {
      kind: 'settings';
      tab: 'prompt-shortcuts';
      workspaceId?: string;
      create?: true;
    }
  | {
      kind: 'settings';
      tab: 'machines' | 'memory';
      workspaceId?: string;
      machineId?: string;
    }
  | {
      kind: 'settings';
      tab: Exclude<
        AppSettingsLinkTab,
        'agents' | 'agent-roles' | 'mcp' | 'projects' | 'prompt-shortcuts' | 'machines' | 'memory'
      >;
      workspaceId?: string;
    }
  | {
      kind: 'schedules';
      workspaceId?: string;
      create?: true;
      scheduleId?: string;
    };

const SETTINGS_TAB_SET = new Set<string>(APP_SETTINGS_LINK_TABS);
const BUILTIN_AGENT_SET = new Set<string>(AGENT_CREATE_BUILTIN_TARGETS);
const PRESET_AGENT_SET = new Set<string>(AGENT_CREATE_PRESET_TARGETS);
const PROJECT_PAGE_SET = new Set<string>(PROJECT_LINK_PAGES);
const REGISTRY_AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function isValidRepoFullName(value: string): boolean {
  const parts = value.split('/');
  if (parts.length !== 2) return false;
  return parts.every((part) => part !== '.' && part !== '..' && REPO_SEGMENT.test(part));
}

function parseAgentCreateTarget(raw: string): AgentCreateLinkTarget | null {
  if (raw === 'custom') return { kind: 'custom' };
  if (BUILTIN_AGENT_SET.has(raw)) {
    return { kind: 'builtin', agentType: raw as (typeof AGENT_CREATE_BUILTIN_TARGETS)[number] };
  }
  if (PRESET_AGENT_SET.has(raw)) {
    return { kind: 'preset', presetId: raw as (typeof AGENT_CREATE_PRESET_TARGETS)[number] };
  }
  if (raw.startsWith('registry:')) {
    const agentType = raw.slice('registry:'.length);
    return REGISTRY_AGENT_ID.test(agentType) ? { kind: 'registry', agentType } : null;
  }
  return null;
}

function formatAgentCreateTarget(target: AgentCreateLinkTarget): string {
  switch (target.kind) {
    case 'builtin':
      if (!BUILTIN_AGENT_SET.has(target.agentType)) throw new Error('Invalid builtin agent target');
      return target.agentType;
    case 'preset':
      if (!PRESET_AGENT_SET.has(target.presetId)) throw new Error('Invalid preset agent target');
      return target.presetId;
    case 'custom':
      return 'custom';
    case 'registry':
      if (!REGISTRY_AGENT_ID.test(target.agentType))
        throw new Error('Invalid registry agent target');
      return `registry:${target.agentType}`;
  }
}

function hasDisallowedQueryEncoding(rawQuery: string): boolean {
  if (!rawQuery) return false;
  for (const entry of rawQuery.split('&')) {
    const eq = entry.indexOf('=');
    const key = eq >= 0 ? entry.slice(0, eq) : entry;
    const val = eq >= 0 ? entry.slice(eq + 1) : '';
    if (key.includes('%')) return true;
    if (key === 'repo') {
      if (/%(?!2F)/u.test(val)) return true;
    } else if (val.includes('%')) {
      return true;
    }
  }
  return false;
}

function readBoundedParams(url: URL, allowedKeys: readonly string[]): Map<string, string> | null {
  const allowed = new Set(allowedKeys);
  const out = new Map<string, string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) return null;
    const values = url.searchParams.getAll(key);
    if (values.length !== 1) return null;
    const value = values[0] ?? '';
    if (!value) return null;
    out.set(key, value);
  }
  const workspace = out.get('workspace');
  if (workspace !== undefined && !ID.test(workspace)) return null;
  return out;
}

export function buildAppActionLink(target: AppActionLink): string {
  const query = new URLSearchParams();
  if (target.workspaceId !== undefined) {
    if (!ID.test(target.workspaceId)) throw new Error('Invalid workspace identifier');
    query.set('workspace', target.workspaceId);
  }
  let path: string;
  if (target.kind === 'schedules') {
    if (target.create && target.scheduleId !== undefined) {
      throw new Error('Schedules link cannot combine create and scheduleId');
    }
    if (target.create) query.set('create', '1');
    if (target.scheduleId !== undefined) {
      if (!ID.test(target.scheduleId) || target.scheduleId === 'new') {
        throw new Error('Invalid schedule identifier');
      }
      query.set('schedule', target.scheduleId);
    }
    path = 'schedules';
  } else {
    if (!SETTINGS_TAB_SET.has(target.tab)) throw new Error('Invalid settings tab');
    path = `settings/${target.tab}`;
    switch (target.tab) {
      case 'agents': {
        if (target.create && target.configId !== undefined) {
          throw new Error('Agents link cannot combine create and configId');
        }
        if (target.machineId !== undefined) {
          if (!ID.test(target.machineId)) throw new Error('Invalid machine identifier');
          query.set('machine', target.machineId);
        }
        if (target.create) query.set('create', formatAgentCreateTarget(target.create));
        if (target.configId !== undefined) {
          if (!ID.test(target.configId)) throw new Error('Invalid agent config identifier');
          query.set('config', target.configId);
        }
        break;
      }
      case 'agent-roles': {
        if (target.create && target.roleId !== undefined) {
          throw new Error('Agent Roles link cannot combine create and roleId');
        }
        if (target.machineId !== undefined) {
          if (!ID.test(target.machineId)) throw new Error('Invalid machine identifier');
          query.set('machine', target.machineId);
        }
        if (target.create) query.set('create', '1');
        if (target.roleId !== undefined) {
          if (!ID.test(target.roleId)) throw new Error('Invalid role identifier');
          query.set('role', target.roleId);
        }
        break;
      }
      case 'mcp': {
        if (target.create && target.serverId !== undefined) {
          throw new Error('MCP link cannot combine create and serverId');
        }
        if (target.create) query.set('create', '1');
        if (target.serverId !== undefined) {
          if (!ID.test(target.serverId)) throw new Error('Invalid MCP server identifier');
          query.set('server', target.serverId);
        }
        break;
      }
      case 'projects': {
        if (target.add) {
          if (target.repoFullName || target.localProjectId || target.page) {
            throw new Error('Projects add link cannot select a specific project or page');
          }
          if (target.add === 'group' && target.machineId !== undefined) {
            throw new Error('Project group wizard does not take a machine parameter');
          }
          if (target.machineId !== undefined) {
            if (!ID.test(target.machineId)) throw new Error('Invalid machine identifier');
            query.set('machine', target.machineId);
          }
          query.set('add', target.add);
          break;
        }
        if (target.repoFullName !== undefined && target.localProjectId !== undefined) {
          throw new Error('Projects link cannot combine repo and local project');
        }
        if (target.repoFullName !== undefined) {
          if (target.machineId !== undefined || target.page === 'conversations') {
            throw new Error('Invalid GitHub project link options');
          }
          if (!isValidRepoFullName(target.repoFullName)) throw new Error('Invalid repository name');
          query.set('repo', target.repoFullName);
        } else if (target.localProjectId !== undefined) {
          if (!target.machineId || !ID.test(target.machineId) || !ID.test(target.localProjectId)) {
            throw new Error('Local project link requires valid machine and local identifiers');
          }
          query.set('machine', target.machineId);
          query.set('local', target.localProjectId);
        } else {
          if (target.page !== undefined) {
            throw new Error('Project page requires a target project');
          }
          if (target.machineId !== undefined) {
            if (!ID.test(target.machineId)) throw new Error('Invalid machine identifier');
            query.set('machine', target.machineId);
          }
        }
        if (target.page !== undefined) {
          if (!PROJECT_PAGE_SET.has(target.page)) throw new Error('Invalid project page');
          query.set('page', target.page);
        }
        break;
      }
      case 'prompt-shortcuts': {
        if (target.create) query.set('create', '1');
        break;
      }
      case 'machines':
      case 'memory': {
        if (target.machineId !== undefined) {
          if (!ID.test(target.machineId)) throw new Error('Invalid machine identifier');
          query.set('machine', target.machineId);
        }
        break;
      }
      default:
        break;
    }
  }
  const url = `${LODY_PROTOCOLS.resource}://${path}${query.size ? `?${query}` : ''}`;
  if (url.length > 8192) throw new Error('Action link is too long');
  return url;
}

export function parseAppActionLink(raw: string): AppActionLink | null {
  if (raw.length > 8192 || /[\s\\#]/u.test(raw)) return null;
  if (!/^[a-zA-Z.-]+:\/\/(?:schedules|settings\/[a-z-]+)(?:\?[^#]*)?$/u.test(raw)) {
    return null;
  }
  const qIndex = raw.indexOf('?');
  if (qIndex >= 0 && hasDisallowedQueryEncoding(raw.slice(qIndex + 1))) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!SCHEMES.has(url.protocol) || url.port || url.username || url.password || url.hash) {
    return null;
  }
  if (url.hostname === 'schedules') {
    if (url.pathname && url.pathname !== '/') return null;
    if (raw.slice(0, qIndex >= 0 ? qIndex : raw.length).endsWith('/')) return null;
    const params = readBoundedParams(url, ['workspace', 'create', 'schedule']);
    if (!params) return null;
    const workspaceId = params.get('workspace');
    const create = params.get('create');
    const scheduleId = params.get('schedule');
    if (create !== undefined && scheduleId !== undefined) return null;
    if (create !== undefined && create !== '1') return null;
    if (scheduleId !== undefined && (!ID.test(scheduleId) || scheduleId === 'new')) return null;
    return {
      kind: 'schedules',
      ...(workspaceId ? { workspaceId } : {}),
      ...(create === '1' ? { create: true } : {}),
      ...(scheduleId ? { scheduleId } : {}),
    };
  }
  if (url.hostname !== 'settings') return null;
  const tabRaw = url.pathname.slice(1);
  if (!SETTINGS_TAB_SET.has(tabRaw)) return null;
  const tab = tabRaw as AppSettingsLinkTab;

  switch (tab) {
    case 'agents': {
      const params = readBoundedParams(url, ['workspace', 'machine', 'create', 'config']);
      if (!params) return null;
      const workspaceId = params.get('workspace');
      const machineId = params.get('machine');
      const createRaw = params.get('create');
      const configId = params.get('config');
      if (createRaw !== undefined && configId !== undefined) return null;
      if (machineId !== undefined && !ID.test(machineId)) return null;
      if (configId !== undefined && !ID.test(configId)) return null;
      const create = createRaw !== undefined ? parseAgentCreateTarget(createRaw) : undefined;
      if (createRaw !== undefined && !create) return null;
      return {
        kind: 'settings',
        tab: 'agents',
        ...(workspaceId ? { workspaceId } : {}),
        ...(machineId ? { machineId } : {}),
        ...(create ? { create } : {}),
        ...(configId ? { configId } : {}),
      };
    }
    case 'agent-roles': {
      const params = readBoundedParams(url, ['workspace', 'machine', 'create', 'role']);
      if (!params) return null;
      const workspaceId = params.get('workspace');
      const machineId = params.get('machine');
      const create = params.get('create');
      const roleId = params.get('role');
      if (create !== undefined && roleId !== undefined) return null;
      if (machineId !== undefined && !ID.test(machineId)) return null;
      if (create !== undefined && create !== '1') return null;
      if (roleId !== undefined && !ID.test(roleId)) return null;
      return {
        kind: 'settings',
        tab: 'agent-roles',
        ...(workspaceId ? { workspaceId } : {}),
        ...(machineId ? { machineId } : {}),
        ...(create === '1' ? { create: true } : {}),
        ...(roleId ? { roleId } : {}),
      };
    }
    case 'mcp': {
      const params = readBoundedParams(url, ['workspace', 'create', 'server']);
      if (!params) return null;
      const workspaceId = params.get('workspace');
      const create = params.get('create');
      const serverId = params.get('server');
      if (create !== undefined && serverId !== undefined) return null;
      if (create !== undefined && create !== '1') return null;
      if (serverId !== undefined && !ID.test(serverId)) return null;
      return {
        kind: 'settings',
        tab: 'mcp',
        ...(workspaceId ? { workspaceId } : {}),
        ...(create === '1' ? { create: true } : {}),
        ...(serverId ? { serverId } : {}),
      };
    }
    case 'projects': {
      const params = readBoundedParams(url, [
        'workspace',
        'machine',
        'add',
        'repo',
        'local',
        'page',
      ]);
      if (!params) return null;
      const workspaceId = params.get('workspace');
      const machineId = params.get('machine');
      const add = params.get('add');
      const repoFullName = params.get('repo');
      const localProjectId = params.get('local');
      const pageRaw = params.get('page');
      if (machineId !== undefined && !ID.test(machineId)) return null;
      if (add !== undefined) {
        if (add !== 'local' && add !== 'group') return null;
        if (repoFullName !== undefined || localProjectId !== undefined || pageRaw !== undefined) {
          return null;
        }
        if (add === 'group' && machineId !== undefined) return null;
        return {
          kind: 'settings',
          tab: 'projects',
          ...(workspaceId ? { workspaceId } : {}),
          ...(machineId ? { machineId } : {}),
          add,
        };
      }
      if (repoFullName !== undefined && localProjectId !== undefined) return null;
      if (pageRaw !== undefined && !PROJECT_PAGE_SET.has(pageRaw)) return null;
      const page = pageRaw as ProjectLinkPage | undefined;
      if (repoFullName !== undefined) {
        if (machineId !== undefined || page === 'conversations') return null;
        if (!isValidRepoFullName(repoFullName)) return null;
        return {
          kind: 'settings',
          tab: 'projects',
          ...(workspaceId ? { workspaceId } : {}),
          repoFullName,
          ...(page ? { page } : {}),
        };
      }
      if (localProjectId !== undefined) {
        if (!machineId || !ID.test(localProjectId)) return null;
        return {
          kind: 'settings',
          tab: 'projects',
          ...(workspaceId ? { workspaceId } : {}),
          machineId,
          localProjectId,
          ...(page ? { page } : {}),
        };
      }
      if (page !== undefined) return null;
      return {
        kind: 'settings',
        tab: 'projects',
        ...(workspaceId ? { workspaceId } : {}),
        ...(machineId ? { machineId } : {}),
      };
    }
    case 'prompt-shortcuts': {
      const params = readBoundedParams(url, ['workspace', 'create']);
      if (!params) return null;
      const workspaceId = params.get('workspace');
      const create = params.get('create');
      if (create !== undefined && create !== '1') return null;
      return {
        kind: 'settings',
        tab: 'prompt-shortcuts',
        ...(workspaceId ? { workspaceId } : {}),
        ...(create === '1' ? { create: true } : {}),
      };
    }
    case 'machines':
    case 'memory': {
      const params = readBoundedParams(url, ['workspace', 'machine']);
      if (!params) return null;
      const workspaceId = params.get('workspace');
      const machineId = params.get('machine');
      if (machineId !== undefined && !ID.test(machineId)) return null;
      return {
        kind: 'settings',
        tab,
        ...(workspaceId ? { workspaceId } : {}),
        ...(machineId ? { machineId } : {}),
      };
    }
    default: {
      const params = readBoundedParams(url, ['workspace']);
      if (!params) return null;
      const workspaceId = params.get('workspace');
      return {
        kind: 'settings',
        tab,
        ...(workspaceId ? { workspaceId } : {}),
      };
    }
  }
}

/** A link the app opens itself: a conversation, a Today page, or an in-app UI action. */
export function isAppResourceLink(raw: string): boolean {
  return (
    parseSessionLink(raw) !== null ||
    parseTodayLink(raw) !== null ||
    parseAppActionLink(raw) !== null
  );
}
