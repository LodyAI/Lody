import { PromptShortcutError } from './model';

/** Legacy per-owner/visibility index domain (Phase 1 dual-read fallback only). */
export type ShortcutAccessDomain = {
  workspaceId: string;
  ownerUserId: string;
  visibility: 'private' | 'workspace';
};

export type WorkspaceShortcutResource =
  | { kind: 'workspace-index'; workspaceId: string }
  | { kind: 'workspace-body'; workspaceId: string; bodyDocId: string };

export type LegacyShortcutResource =
  | { kind: 'index'; domain: ShortcutAccessDomain }
  | { kind: 'body'; bodyDocId: string };

export type ShortcutResource = WorkspaceShortcutResource | LegacyShortcutResource;

const encode = (value: string): string => {
  if (!value || value.length > 200)
    throw new PromptShortcutError('invalid_template', 'Invalid access-domain identifier');
  return encodeURIComponent(value);
};

/**
 * Workspace-prefixed stream segments cannot contain `:`, `/`, whitespace, NUL, or `..`.
 * Every workspace-owned stream ID must put `{workspaceId}:` first (before any feature
 * discriminator) so Loro Streams attributes `{workspaceId}:shortcut-index` and
 * `{workspaceId}:shortcut:{bodyDocId}` to `space_id = {workspaceId}`.
 * See `.agents/docs/loro-streams-user-space.md`.
 */
const encodeWorkspaceSegment = (value: string): string => {
  if (!value || value.length > 200 || /[:/\s\0]/.test(value) || value.includes('..'))
    throw new PromptShortcutError('invalid_template', 'Invalid shortcut stream identifier');
  return encodeURIComponent(value);
};

export function getWorkspaceShortcutIndexStreamId(workspaceId: string): string {
  return `${encodeWorkspaceSegment(workspaceId)}:shortcut-index`;
}

export function getWorkspaceShortcutBodyStreamId(workspaceId: string, bodyDocId: string): string {
  return `${encodeWorkspaceSegment(workspaceId)}:shortcut:${encodeWorkspaceSegment(bodyDocId)}`;
}

export function getLocalShortcutWorkingDocId(shortcutId: string): string {
  return `shortcut-working:${encode(shortcutId)}`;
}

/** @deprecated Legacy global-prefix index stream (`space_id = 'shortcut-index'`). Read-only fallback during Phase 1 migration. */
export function getShortcutIndexStreamId(domain: ShortcutAccessDomain): string {
  return `shortcut-index:${encode(domain.workspaceId)}:${encode(domain.ownerUserId)}:${domain.visibility}`;
}

/** @deprecated Legacy global-prefix body stream (`space_id = 'shortcut-body'`). Read-only fallback during Phase 1 migration. */
export function getShortcutBodyStreamId(documentId: string): string {
  return `shortcut-body:${encode(documentId)}`;
}

export function getShortcutResourceStreamId(resource: ShortcutResource): string {
  switch (resource.kind) {
    case 'workspace-index':
      return getWorkspaceShortcutIndexStreamId(resource.workspaceId);
    case 'workspace-body':
      return getWorkspaceShortcutBodyStreamId(resource.workspaceId, resource.bodyDocId);
    case 'index':
      return getShortcutIndexStreamId(resource.domain);
    case 'body':
      return getShortcutBodyStreamId(resource.bodyDocId);
  }
}

/** @deprecated Legacy domain check retained only for Convex legacy stream authorization during Phase 1 transition. */
export function canAccessShortcutDomain(input: {
  domain: ShortcutAccessDomain;
  userId: string;
  isWorkspaceMember: boolean;
  operation: 'read' | 'write';
}): boolean {
  if (!input.isWorkspaceMember) return false;
  if (input.domain.ownerUserId === input.userId) return true;
  return input.operation === 'read' && input.domain.visibility === 'workspace';
}
