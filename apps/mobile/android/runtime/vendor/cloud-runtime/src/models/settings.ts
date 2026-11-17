export type RemoteSetting = {
  kind: 'machine' | 'agent';
  id: string;
  name: string;
  machineId?: string;
  machineName?: string;
  readOnly?: boolean;
  detail?: string;
  prompt?: string;
};

export type SettingsRequest = {
  workspaceId: string;
  kind: RemoteSetting['kind'];
  edit?: {
    item: RemoteSetting;
    name: string;
    prompt?: string;
  };
};
