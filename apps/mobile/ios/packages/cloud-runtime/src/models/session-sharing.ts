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

/** Credential-free projection of the official published inventory/management entry. */
export type PublishedShare = {
  shareId: string;
  rootSessionId: string;
  publisherUserId: string;
  status: 'active' | 'revoked';
  title: string;
  revision: number;
  credentialVersion: number;
  createdAt: number;
  updatedAt: number;
  totalBytes?: number;
  conversationCount?: number;
  canManage: boolean;
  canRevoke: boolean;
  hasLocalLink: boolean;
};
export type PublishedSharePage = {
  workspaceId: string;
  userId: string;
  page: PublishedShare[];
  isDone: boolean;
  continueCursor: string;
};
export type PublishedSharesRequest = { workspaceId: string } & (
  | { action: 'list'; cursor?: string | null }
  | {
      action: 'detail' | 'copy' | 'open' | 'revoke';
      shareId: string;
      rootSessionId: string;
      expectedRevision?: number;
    }
);
