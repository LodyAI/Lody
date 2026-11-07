export type RemoteSetting = {
  kind: 'machine' | 'agent' | 'mcp';
  id: string;
  name: string;
  machineId?: string;
  machineName?: string;
  readOnly?: boolean;
  detail?: string;
  prompt?: string;
  enabledByDefault?: boolean;
  configured?: boolean;
  updatedAt?: number;
};

export type SettingsRequest = {
  workspaceId: string;
  kind: RemoteSetting['kind'];
  edit?: {
    item: RemoteSetting;
    name: string;
    prompt?: string;
    enabledByDefault?: boolean;
  };
  remove?: RemoteSetting;
};
