export interface PluginEnvField {
  readonly description: string;
  readonly required?: boolean;
  readonly secret?: boolean;
}

export interface BundledMcpServer {
  readonly command: string;
  readonly args?: readonly string[];
}

export type PluginAcpProvider =
  | {
      readonly type: 'bundled';
      readonly id: string;
      readonly title: string;
      readonly command: string;
      readonly args?: readonly string[];
    }
  | {
      readonly type: 'managed';
      readonly runtimeId: string;
    };

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly sdk: '^1.0.0';
  readonly title: string;
  readonly description?: string;
  readonly client?: string;
  readonly machine?: string;
  readonly skills?: readonly string[];
  readonly env?: Readonly<Record<string, PluginEnvField>>;
  readonly mcpServers?: Readonly<Record<string, BundledMcpServer>>;
  readonly acpProviders?: readonly PluginAcpProvider[];
}
