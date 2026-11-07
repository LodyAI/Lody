export type MentionCategory =
  'file' | 'skill' | 'session' | 'role' | 'issue' | 'pr' | 'cmd';
export type MentionItem = {
  path: string;
  name: string;
  kind: MentionCategory | 'directory';
  subtitle: string;
  insertText?: string;
  /** Role target labels may differ from the catalog Role name. */
  roleName?: string;
  /** A Role's emoji, shown before its name. */
  emoji?: string;
};
export type MentionSource = {
  workspaceId: string;
  sessionId?: string;
  projectId?: string;
  machineId?: string;
  agentConfigId?: string;
  cliType?: string;
  agentType?: string;
};
export type MentionCatalog = {
  items: MentionItem[];
  truncated: boolean;
  incomplete: boolean;
};
