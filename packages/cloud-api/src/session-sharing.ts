import type { SharePackageManifest } from '@lody/shared/session-sharing';

import type { SessionShareRequestStatus } from '@lody/shared/session-sharing';
export type {
  SessionShareRequestInput,
  SessionShareRequestStatus,
} from '@lody/shared/session-sharing';
export type SessionShareRequest = {
  requestId: string;
  sourceSessionId: string;
  sessionIds: string[];
  createdAt: number;
  expiresAt: number;
  status: SessionShareRequestStatus | 'published';
  shareId?: string;
};

/** Authenticated control-plane DTOs never return a credential or its hash. */
export type SessionShareView = {
  shareId: string;
  rootSessionId: string;
  publisherUserId: string;
  status: 'draft' | 'active' | 'revoked';
  revision: number;
  credentialVersion: number;
  currentDeploymentId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};
export type SessionShareManagementEntry = SessionShareView & {
  sourceIds: { sourceId: string; conversationId: string }[];
  selectedSourceIds: string[];
  canManage: boolean;
  canRevoke: boolean;
};
export type SessionShareManagement = SessionShareManagementEntry | null;
export type PublishedSessionShare = Omit<SessionShareView, 'status'> & {
  status: 'active' | 'revoked';
  totalBytes: number;
  conversationCount: number;
  canManage: boolean;
  canRevoke: boolean;
};
export type PublishedSessionSharePage = {
  page: PublishedSessionShare[];
  isDone: boolean;
  continueCursor: string;
};
export type BeginShareDeployment = {
  workspaceId: string;
  rootSessionId: string;
  shareId?: string;
  expectedRevision?: number;
  credentialHash?: string;
  uploadCredentialHash: string;
  requestId: string;
  manifest: SharePackageManifest;
  sourceIds: { sourceId: string; conversationId: string }[];
  confirmationRequestId?: string;
};
