import type { SettingsTabId } from './settings-tabs';

function settingsCodeLoader<T>(load: () => Promise<T>) {
  let loading: Promise<T> | undefined;
  return () =>
    (loading ??= load().catch((error: unknown) => {
      loading = undefined;
      throw error;
    }));
}

export const loadWorkspaceSettings = settingsCodeLoader(() =>
  import('./e2ee/workspace-security').then((module) => ({ default: module.WorkspaceSettings }))
);
export const loadMemorySetting = settingsCodeLoader(() =>
  import('./memory-setting').then((module) => ({ default: module.MemorySetting }))
);
export const loadGeneralSettingsComponent = settingsCodeLoader(() =>
  import('./general-setting').then((module) => ({ default: module.GeneralSettingsComponent }))
);
export const loadAppearanceSettingsComponent = settingsCodeLoader(() =>
  import('./appearance-setting').then((module) => ({ default: module.AppearanceSettingsComponent }))
);
export const loadAccountSettingsComponent = settingsCodeLoader(() =>
  import('./account-setting').then((module) => ({ default: module.AccountSettingsComponent }))
);
export const loadBillingSettingsComponent = settingsCodeLoader(() =>
  import('./billing-setting').then((module) => ({ default: module.BillingSettingsComponent }))
);
export const loadStatsSettingsComponent = settingsCodeLoader(() =>
  import('./stats-setting').then((module) => ({ default: module.StatsSettingsComponent }))
);
export const loadProjectSettingsComponent = settingsCodeLoader(() =>
  import('./project-settings').then((module) => ({ default: module.ProjectSettingsComponent }))
);
export const loadMachineAgentSettings = settingsCodeLoader(() =>
  import('./machine-agent-settings').then((module) => ({ default: module.MachineAgentSettings }))
);
export const loadLodyAgentSetting = settingsCodeLoader(() =>
  import('./lody-agent-setting').then((module) => ({ default: module.LodyAgentSetting }))
);
export const loadIntegrationsSettingsComponent = settingsCodeLoader(() =>
  import('./integrations-setting').then((module) => ({
    default: module.IntegrationsSettingsComponent,
  }))
);
export const loadKeyboardShortcutsSetting = settingsCodeLoader(() =>
  import('./keyboard-shortcuts-setting').then((module) => ({
    default: module.KeyboardShortcutsSetting,
  }))
);
export const loadAboutSettingsComponent = settingsCodeLoader(() =>
  import('./about-setting').then((module) => ({ default: module.AboutSettingsComponent }))
);
export const loadAgentRolesSetting = settingsCodeLoader(() =>
  import('./agent-roles-setting').then((module) => ({ default: module.AgentRolesSetting }))
);
export const loadPromptShortcutsSetting = settingsCodeLoader(() =>
  import('./prompt-shortcuts-setting').then((module) => ({
    default: module.PromptShortcutsSetting,
  }))
);
export const loadMcpSetting = settingsCodeLoader(() =>
  import('./mcp-setting').then((module) => ({ default: module.McpSetting }))
);
export const loadShareManagementSetting = settingsCodeLoader(() =>
  import('./share-management-setting').then((module) => ({
    default: module.ShareManagementSetting,
  }))
);

const panels = {
  preferences: loadGeneralSettingsComponent,
  appearance: loadAppearanceSettingsComponent,
  account: loadAccountSettingsComponent,
  people: loadAccountSettingsComponent,
  workspace: loadWorkspaceSettings,
  billing: loadBillingSettingsComponent,
  'ai-usage': loadStatsSettingsComponent,
  projects: loadProjectSettingsComponent,
  agents: loadMachineAgentSettings,
  machines: loadMachineAgentSettings,
  'lody-agent': loadLodyAgentSetting,
  memory: loadMemorySetting,
  'agent-roles': loadAgentRolesSetting,
  'prompt-shortcuts': loadPromptShortcutsSetting,
  mcp: loadMcpSetting,
  shares: loadShareManagementSetting,
  github: loadIntegrationsSettingsComponent,
  'keyboard-shortcuts': loadKeyboardShortcutsSetting,
  about: loadAboutSettingsComponent,
} satisfies Record<SettingsTabId, () => Promise<unknown>>;
export const loadSettingsModal = settingsCodeLoader(() =>
  import('./desktop-settings-modal').then((module) => ({ default: module.DesktopSettingsModal }))
);
export function preloadSettingsPanel(tab: SettingsTabId) {
  return panels[tab]();
}
export async function preloadSettings(tab: SettingsTabId, mobile = false) {
  await Promise.all([...(mobile ? [] : [loadSettingsModal()]), preloadSettingsPanel(tab)]);
}
