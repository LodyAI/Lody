import type { SessionShareVersions } from '@lody/shared/session-sharing';

/** Authenticated management DTOs. Credentials and their hashes are never returned. */
export type SessionShareView = SessionShareVersions & {
  shareId: string;
  rootSessionId: string;
  authorUserId: string;
  status: 'active' | 'revoked';
};

export type SessionShareManagementEntry = SessionShareView & {
  title: string | null;
  sessionIds: string[];
  readableSessionIds: string[];
  validUntil: number | null;
  canManage: boolean;
  canRevoke: boolean;
};

export type SessionShareManagement = {
  root: SessionShareManagementEntry | null;
  /** All independent grants containing this session, including its own entry. */
  sources: SessionShareManagementEntry[];
  candidates: {
    sessionId: string;
    /** Only verified source metadata is returned. Local labels are display hints. */
    title: string | null;
    available: boolean;
    validUntil: number | null;
  }[];
};
