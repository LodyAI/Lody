import { isReservedWorkspaceSlug, type Organization } from '@lody/shared';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const maxSlugLength = 40;
const minSlugLength = 3;
const allowedSlugCharsPattern = /^[a-z0-9-]+$/;
const preferredWorkspaceSlugStorageKey = 'lody:preferredWorkspaceSlug';

/**
 * 归一化 workspace slug，确保只包含小写字母、数字和短横线。
 */
export const normalizeWorkspaceSlug = (value: string): string => {
  if (!value) return '';
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, maxSlugLength);
};

/**
 * 归一化 slug 输入，同时允许用户在编辑阶段保留末尾的短横线。
 */
export const normalizeWorkspaceSlugInput = (value: string): string => {
  if (!value) return '';
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^-+/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, maxSlugLength);
};

export type WorkspaceSlugRuleError =
  | 'invalidChars'
  | 'invalidLength'
  | 'invalidTrailing'
  | 'unavailable';

/**
 * 针对单个规则的 slug 错误，用于给出更细颗粒度的提示。
 * 保留名称按“已被占用”处理，避免暴露内部路由规划。
 */
export const getWorkspaceSlugRuleError = (slug: string): WorkspaceSlugRuleError | null => {
  if (!slug) {
    return null;
  }
  if (isReservedWorkspaceSlug(slug)) {
    return 'unavailable';
  }
  if (slug.length < minSlugLength || slug.length > maxSlugLength) {
    return 'invalidLength';
  }
  if (!allowedSlugCharsPattern.test(slug) || slug.includes('--')) {
    return 'invalidChars';
  }
  if (slug.endsWith('-')) {
    return 'invalidTrailing';
  }
  return null;
};

/**
 * 判断 slug 是否满足格式与长度限制。
 */
export const isValidWorkspaceSlug = (slug: string): boolean => {
  if (!slug) return false;
  if (slug.length < minSlugLength || slug.length > maxSlugLength) {
    return false;
  }
  return slugPattern.test(slug);
};

/**
 * 判断 slug 是否可作为已有 workspace 的导航目标。
 *
 * 这里不检查保留名称：保留名称只阻止新建/改名，不能阻止用户进入历史上已经存在的 workspace。
 * 也不要求最小长度，因为早期自动创建的 workspace 可能来自短用户名（例如 `zh`）。
 */
export const isNavigableWorkspaceSlug = (slug: string): boolean => {
  if (!slug || slug.length > maxSlugLength) return false;
  return slugPattern.test(slug);
};

export const isUsableWorkspaceSlug = (slug: string): boolean => {
  return isValidWorkspaceSlug(slug) && !isReservedWorkspaceSlug(slug);
};

/**
 * 根据工作空间名称生成推荐的 slug。
 */
export const generateWorkspaceSlug = (name: string): string => {
  if (!name.trim()) {
    return '';
  }
  const normalized = normalizeWorkspaceSlug(name);
  if (normalized) {
    return normalized;
  }
  return 'workspace';
};

/**
 * 读取最近一次选择的 workspace slug。
 */
export const readPreferredWorkspaceSlug = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const value = localStorage.getItem(preferredWorkspaceSlugStorageKey);
    if (!value) {
      return null;
    }
    const normalized = value.trim();
    if (!normalized || !isNavigableWorkspaceSlug(normalized)) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
};

/**
 * 记录最近一次选择的 workspace slug。
 */
export const writePreferredWorkspaceSlug = (workspaceSlug: string | null): void => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    if (!workspaceSlug) {
      localStorage.removeItem(preferredWorkspaceSlugStorageKey);
      return;
    }
    localStorage.setItem(preferredWorkspaceSlugStorageKey, workspaceSlug);
  } catch {
    // ignore
  }
};

export const clearPreferredWorkspaceSlug = (): void => {
  writePreferredWorkspaceSlug(null);
};

/**
 * Clear the preferred workspace slug if it matches the given slug.
 * Used when a workspace is deleted or access is denied to prevent redirect loops.
 */
export const clearPreferredWorkspaceSlugIfMatch = (slug: string): void => {
  const current = readPreferredWorkspaceSlug();
  if (current === slug) {
    writePreferredWorkspaceSlug(null);
  }
};

/**
 * 获取当前应该跳转到的 workspace slug。
 * 优先使用当前激活的 workspace，其次使用最近一次选择的 workspace（如果当前用户仍有访问权限），
 * 再次使用列表里第一个存在 slug 的 workspace。
 */
export const getPreferredWorkspaceSlug = (
  activeOrganization?: Pick<Organization, 'slug'> | null,
  organizations?: Array<Pick<Organization, 'slug'>> | null,
  preferredWorkspaceSlug?: string | null
): string | null => {
  if (activeOrganization?.slug && isNavigableWorkspaceSlug(activeOrganization.slug)) {
    return activeOrganization.slug;
  }

  if (
    preferredWorkspaceSlug &&
    isNavigableWorkspaceSlug(preferredWorkspaceSlug) &&
    organizations?.some((organization) => organization.slug === preferredWorkspaceSlug)
  ) {
    return preferredWorkspaceSlug;
  }

  const fallback = organizations?.find(
    (org): org is { slug: string } => Boolean(org.slug) && isNavigableWorkspaceSlug(org.slug)
  )?.slug;
  return fallback ?? null;
};

type ReturnCandidate = { slug?: string | null; contentMode?: string };
const isOrdinaryWithSlug = (
  workspace: ReturnCandidate | null | undefined
): workspace is ReturnCandidate & { slug: string } =>
  typeof workspace?.slug === 'string' && workspace.contentMode !== 'e2ee';

/**
 * The workspace a "back to workspaces" exit opens: the preferred ORDINARY one.
 * Workspace lists merge encrypted workspaces in, and the selected one is often
 * active, but an encrypted workspace's chat route sends a device whose runtime
 * is not open straight back to its control page — so an exit that lands there
 * loops. `null` means there is no such workspace and no back exit to offer.
 */
export const getPreferredOrdinaryWorkspaceSlug = (
  activeWorkspace: ReturnCandidate | null | undefined,
  workspaces: readonly ReturnCandidate[] | null | undefined,
  preferredWorkspaceSlug: string | null
): string | null =>
  getPreferredWorkspaceSlug(
    isOrdinaryWithSlug(activeWorkspace) ? activeWorkspace : null,
    workspaces?.filter(isOrdinaryWithSlug),
    preferredWorkspaceSlug
  );
