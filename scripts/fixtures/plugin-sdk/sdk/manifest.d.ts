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

/**
 * Machine-agnostic Agent Role blueprint shipped inside a plugin package.
 * Unlike workspace `AgentRole` rows (which bind a user's concrete `machineId + agentConfigId`),
 * blueprints let a plugin distribute a multi-Agent team preset that each user maps onto their own
 * available machines and model configs when enabling the plugin.
 */
export interface PluginAgentRoleBlueprint {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly emoji?: string;
  readonly promptPrefix: string;
  readonly defaultSkills?: readonly string[];
  readonly preferredModelTier?: 'reasoning' | 'balanced' | 'fast';
  readonly preferredCliTypes?: readonly string[];
}

export type PluginSettingScope = 'user' | 'project' | 'installation';

export type PluginSettingField = {
  readonly title: string;
  readonly description?: string;
  readonly scope?: PluginSettingScope;
} & (
  | { readonly type: 'string'; readonly default?: string; readonly secret?: boolean }
  | {
      readonly type: 'number';
      readonly default?: number;
      readonly min?: number;
      readonly max?: number;
    }
  | { readonly type: 'boolean'; readonly default?: boolean }
  | {
      readonly type: 'select';
      readonly options: readonly { readonly value: string; readonly label: string }[];
      readonly default?: string;
    }
  | {
      /** Binds a user's concrete `(machineId, agentConfigId)` or workspace `AgentRole` to a plugin slot. */
      readonly type: 'roleTarget';
      readonly blueprintId?: string;
    }
);

/**
 * VS Code color theme JSON shipped in `assets/` and applied through Lody's built-in theme engine
 * across app chrome tokens, Monaco editors, Shiki code blocks, and integrated terminals.
 */
export interface PluginThemeContribution {
  readonly id: string;
  readonly label: string;
  readonly appearance: 'dark' | 'light';
  readonly path: string;
}

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly sdk: '^1.0.0';
  readonly title: string;
  readonly description?: string;
  readonly client?: string;
  readonly machine?: string;
  readonly skills?: readonly string[];
  readonly agentRoles?: readonly PluginAgentRoleBlueprint[];
  readonly settings?: Readonly<Record<string, PluginSettingField>>;
  readonly themes?: readonly PluginThemeContribution[];
  /** Optional stylesheet asset paths injected when the user enables custom shell styling on the client. */
  readonly styles?: readonly string[];
  readonly env?: Readonly<Record<string, PluginEnvField>>;
  readonly mcpServers?: Readonly<Record<string, BundledMcpServer>>;
  readonly acpProviders?: readonly PluginAcpProvider[];
}
