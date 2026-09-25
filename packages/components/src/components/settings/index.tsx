import * as stylex from '@stylexjs/stylex';
import { settingsSurface } from './surface';

export { GeneralSettingsComponent } from './general-setting';
export { AppearanceSettingsComponent, AppearanceSettingsView } from './appearance-setting';
export type { AppearanceSettingsViewProps } from './appearance-setting';
export { MachineAgentSettings } from './machine-agent-settings';
export { ProjectSettingsComponent, ProjectSettingsView } from './project-settings';
export { IntegrationsSettingsComponent } from './integrations-setting';
export { AccountSettingsComponent } from './account-setting';
export { AccountSettingsPure } from './account-setting-pure';
export type { AccountSettingsPureProps, AccountMember } from './account-setting-pure';
export { BillingSettingsComponent } from './billing-setting';
export { StatsSettingsComponent } from './stats-setting';
export { AboutSettingsComponent } from './about-setting';
export { KeyboardShortcutsSetting } from './keyboard-shortcuts-setting';
export { SettingsHeader } from './settings-header';
export { SettingsCategoryList, SettingsCategoryGrid } from './settings-category-list';

/**
 * The settings page column (`settingsSurface.container`) as a class string, for
 * pages that take it as a `className`. A page that also lays itself out spreads
 * `stylex.props(settingsSurface.container, …)` instead, so the two merge.
 */
export const settingContainerClass = stylex.props(settingsSurface.container).className ?? '';
