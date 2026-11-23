export interface PluginSelectOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/**
 * Declarative configuration field rendered natively by Lody's Plugin Settings & First-Run
 * Onboarding Sheet without requiring custom React boilerplate.
 * - `client`: synced across the user's clients (e.g. sound pack, UI preferences).
 * - `machine`: stored in daemon custody/keychain and passed only to the machine subprocess.
 * - `both`: non-secret setting readable on both client and machine.
 * Note: `type: "secret"` MUST target `scope: "machine"` (default for secrets).
 */
export type PluginConfigField = {
  readonly label: string;
  readonly description?: string;
  readonly required?: boolean;
} & (
  | {
      readonly type: "string";
      readonly scope?: "client" | "machine" | "both";
      readonly default?: string;
      readonly placeholder?: string;
    }
  | {
      readonly type: "secret";
      readonly scope?: "machine";
      readonly placeholder?: string;
    }
  | {
      readonly type: "number";
      readonly scope?: "client" | "machine" | "both";
      readonly default?: number;
      readonly min?: number;
      readonly max?: number;
      readonly step?: number;
    }
  | {
      readonly type: "boolean";
      readonly scope?: "client" | "machine" | "both";
      readonly default?: boolean;
    }
  | {
      readonly type: "select";
      readonly scope?: "client" | "machine" | "both";
      readonly options: readonly PluginSelectOption[];
      readonly default?: string;
    }
);

export interface PluginOnboardingSpec {
  readonly title: string;
  readonly summary?: string;
  /** Keys from `config` prompted in Lody's native first-run setup sheet upon enablement. */
  readonly fields: readonly string[];
}

/**
 * Workflow Role packaged inside a plugin (`plugin:<plugin_id>:<role_id>`), combining system prompt,
 * bundled skills, bundled MCP servers, and optional default Agent/ACP provider.
 */
export interface PluginAgentRoleContribution {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly emoji?: string;
  /** Relative path to the Role markdown prompt file inside the plugin package. */
  readonly promptPath: string;
  readonly skills?: readonly string[];
  readonly mcpServers?: readonly string[];
  /** Built-in provider ID or `plugin:<plugin_id>:<provider_id>` from `acpProviders`. */
  readonly defaultProvider?: string;
}

/**
 * Out-of-daemon MCP server packaged with a plugin. Spawned through Lody's standard MCP harness
 * (`apps/cli/src/agent/AGENTS.md`: MCP tools never execute inside the daemon process).
 */
export interface PluginMcpServerContribution {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly transport: "stdio" | "http";
  /** Relative path to the bundled Node MCP server entrypoint inside the plugin package. */
  readonly entry: string;
  readonly args?: readonly string[];
  /** Declared `config` keys (`string` or `secret`) forwarded as environment variables to this MCP server subprocess. */
  readonly envKeys?: readonly string[];
}

/**
 * Bundled ACP Agent Provider runtime (`Workflow Provider Conformance Profile`), allowing full
 * workflow plugins (e.g. Sorbet Super Assistant) to package a custom Agent harness launched via
 * `acp-session-start-gate.ts` as `plugin:<plugin_id>:<provider_id>`.
 */
export interface PluginAcpProviderContribution {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /** Relative path to the bundled ACP server entrypoint inside the plugin package. */
  readonly entry: string;
  /** Declared `config` keys (`string` or `secret`) forwarded as environment variables to this ACP provider subprocess. */
  readonly envKeys?: readonly string[];
  readonly capabilities?: {
    readonly loadSession?: boolean;
    readonly subagentEvents?: boolean;
    readonly configOptions?: boolean;
  };
}

/**
 * Minimal seed palette from which Lody's theme engine (`vscode-theme-dom.ts` / `vscode-theme-css.ts`)
 * derives app chrome, panel, diff, Monaco, Shiki, and integrated terminal color variables.
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
 * Optional non-color design tokens applied as stable root CSS variables alongside a theme's colors,
 * allowing themes to reshape typography, corner geometry, and UI density without fragile DOM selectors.
 */
export interface PluginThemeTokens {
  readonly fontSans?: string;
  readonly fontMono?: string;
  readonly radius?: string;
  readonly density?: "compact" | "comfortable" | "spacious";
}

/**
 * Theme contribution declared in `lody.plugin.json`: accepts either a full VS Code color theme
 * JSON in `assets/` (`path`) or a compact seed palette (`seed`), plus optional `tokens`.
 */
export type PluginThemeContribution = {
  readonly id: string;
  readonly label: string;
  readonly appearance: "dark" | "light";
  readonly tokens?: PluginThemeTokens;
} & (
  | { readonly path: string; readonly seed?: undefined }
  | { readonly seed: PluginThemeSeedColors; readonly path?: undefined }
);

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly sdk: "^1.0.0";
  readonly title: string;
  readonly description?: string;
  readonly client?: string;
  readonly machine?: string;
  readonly config?: Readonly<Record<string, PluginConfigField>>;
  readonly onboarding?: PluginOnboardingSpec;
  readonly skills?: readonly string[];
  readonly agentRoles?: readonly PluginAgentRoleContribution[];
  readonly mcpServers?: readonly PluginMcpServerContribution[];
  readonly acpProviders?: readonly PluginAcpProviderContribution[];
  readonly themes?: readonly PluginThemeContribution[];
  /**
   * Optional host-managed CSS asset paths injected for the opting-in client.
   * Disposed automatically on disablement/HMR and bypassed in `lody --safe-mode`.
   * Stability contract covers documented CSS variables (`--*`), not internal host DOM structure.
   */
  readonly styles?: readonly string[];
  /** Optional packaged static assets (audio cues, icons, fonts) served across Desktop, Web, and Mobile. */
  readonly assets?: readonly string[];
}
