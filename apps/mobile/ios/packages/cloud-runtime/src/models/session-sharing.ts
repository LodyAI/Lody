export type ShareEntry = {
  shareId: string;
  rootSessionId: string;
  publisherUserId: string;
  status: 'draft' | 'active' | 'revoked';
  revision: number;
  credentialVersion: number;
  currentDeploymentId?: string;
  sourceIds?: { sourceId: string; conversationId: string }[];
  selectedSourceIds?: string[];
  canManage?: boolean;
  canRevoke?: boolean;
};
export type ShareState = {
  entry: ShareEntry | null;
  url: string | null;
  candidates: { id: string; title: string }[];
  selected: string[];
  pending: boolean;
};
export type ShareAction =
  'read' | 'publish' | 'reset' | 'revoke' | 'discard' | 'close';
export type ShareRequest = {
  workspaceId: string;
  sessionId: string;
  editorId: string;
  action: ShareAction;
  selected?: string[];
  omissionText?: string;
};
export type ShareProgress = {
  editorId: string;
  phase: 'capturing' | 'uploading' | 'publishing';
  percent?: number;
};
