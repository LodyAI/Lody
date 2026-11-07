export type HistoryTarget = {
  machineId: string;
  machineName: string;
  localProjectId: string;
  projectName: string;
  rootPath: string;
  provider: { cliType: 'builtin' | 'registry' | 'custom'; agentType: string };
};
export type HistorySession = {
  acpSessionId: string;
  title: string;
  updatedAt?: string;
  importedSessionId?: string;
  status?: 'available' | 'imported' | 'sync_conflict';
};
export type HistoryResult = {
  sessions: HistorySession[];
  failures?: { acpSessionId: string; message: string }[];
};
export type HistoryRequest =
  | { kind: 'targets' }
  | { kind: 'sync'; target: HistoryTarget }
  | { kind: 'import'; target: HistoryTarget; acpSessionIds: string[] }
  | {
      kind: 'resolve';
      target: HistoryTarget;
      sessionId: string;
      acpSessionId: string;
    };
export type HistoryService = (
  request: HistoryRequest,
) => Promise<HistoryTarget[] | HistoryResult>;
