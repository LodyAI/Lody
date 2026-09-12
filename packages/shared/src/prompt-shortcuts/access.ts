import { PromptShortcutError } from './model';

export type ShortcutAccessDomain = {
  workspaceId: string;
  ownerUserId: string;
  visibility: 'private' | 'workspace';
};

export type ShortcutResource =
  | { kind: 'index'; domain: ShortcutAccessDomain }
  | { kind: 'body'; bodyDocId: string };

const encode = (value: string): string => {
  if (!value || value.length > 200)
    throw new PromptShortcutError('invalid_template', 'Invalid access-domain identifier');
  return encodeURIComponent(value);
};

/** Outside `${workspaceId}:` so existing workspace-wide tokens cannot read private content. */
export function getShortcutIndexStreamId(domain: ShortcutAccessDomain): string {
  return `shortcut-index:${encode(domain.workspaceId)}:${encode(domain.ownerUserId)}:${domain.visibility}`;
}

export function getShortcutBodyStreamId(documentId: string): string {
  return `shortcut-body:${encode(documentId)}`;
}

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
