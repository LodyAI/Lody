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
 * Minimal seed palette from which Lody's theme engine automatically derives the complete app
 * chrome, panel, diff, Monaco, Shiki, and integrated terminal tokens.
 */
export interface PluginThemeSeedColors {
  readonly bg: string;
  readonly fg: string;
  readonly accent: string;
  readonly surface?: string;
  readonly border?: string;
  readonly muted?: string;
  readonly success?: string;
  readonly warning?: string;
  readonly danger?: string;
}

/**
 * Theme contribution declared in `lody.plugin.json`: accepts either a full VS Code color theme
 * JSON in `assets/` (`path`) or a compact Paseo/T3-style seed palette (`seed`).
 */
export type PluginThemeContribution = {
  readonly id: string;
  readonly label: string;
  readonly appearance: 'dark' | 'light';
} & (
  | { readonly path: string; readonly seed?: undefined }
  | { readonly seed: PluginThemeSeedColors; readonly path?: undefined }
);

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
