export type MemoryIdentity = {
  id: string;
  name: string;
  description?: string;
  role?: string;
};
export type MemoryAssociation = {
  machineId: string;
  providerId: string;
  memoryId: string;
  name: string;
  description?: string;
};
export type MemoryStatus =
  | 'ready'
  | 'not_installed'
  | 'not_running'
  | 'error'
  | 'offline'
  | 'unknown'
  | 'unsupported'
  | 'forbidden';
export type MemorySnapshot = {
  machines: { id: string; name: string }[];
  machineId?: string;
  entries: MemoryAssociation[];
  identities: MemoryIdentity[];
  status: MemoryStatus;
  cached: boolean;
};
export type MemoryRequest = { workspaceId: string; machineId?: string } & (
  | { action: 'list' }
  | { action: 'import'; memoryId: string }
  | { action: 'remove'; base: MemoryAssociation }
);
