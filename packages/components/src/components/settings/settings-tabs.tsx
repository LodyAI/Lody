import type { LucideIcon } from 'lucide-react';
import type { PlatformCapability } from '@lody/platform';
import { useAppCapabilityCheck } from '../../lib/app-platform';
import {
  Bot,
  Building2,
  ChartNoAxesCombined,
  CreditCard,
  FolderOpen,
  Github,
  Info,
  Keyboard,
  Monitor,
  Palette,
  Plug,
  FileText,
  SlidersHorizontal,
  UserRound,
  UserRoundCog,
} from 'lucide-react';

export type SettingsSectionId = 'account' | 'personal' | 'workspace' | 'other';

export type SettingsTabId =
  | 'account'
  | 'preferences'
  | 'appearance'
  | 'keyboard-shortcuts'
  | 'workspace'
  | 'people'
  | 'machines'
  | 'agents'
  | 'agent-roles'
  | 'prompt-shortcuts'
  | 'mcp'
  | 'projects'
  | 'github'
  | 'ai-usage'
  | 'billing'
  | 'about';

export type SettingsPath =
  | '/$workspaceName/settings/account'
  | '/$workspaceName/settings/preferences'
  | '/$workspaceName/settings/appearance'
  | '/$workspaceName/settings/keyboard-shortcuts'
  | '/$workspaceName/settings/workspace'
  | '/$workspaceName/settings/people'
  | '/$workspaceName/settings/machines'
  | '/$workspaceName/settings/agents'
  | '/$workspaceName/settings/agent-roles'
  | '/$workspaceName/settings/prompt-shortcuts'
  | '/$workspaceName/settings/mcp'
  | '/$workspaceName/settings/projects'
  | '/$workspaceName/settings/github'
  | '/$workspaceName/settings/ai-usage'
  | '/$workspaceName/settings/billing'
  | '/$workspaceName/settings/about';

export type SettingsTabConfig = {
  id: SettingsTabId;
  section: SettingsSectionId;
  labelKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  /** Cloud capability the whole tab depends on; the tab hides when missing. */
  capability?: PlatformCapability;
  /** The workspace machine inventory has no useful distinction in a solo workspace. */
  multiMemberOnly?: boolean;
  path: SettingsPath;
};

export const SETTINGS_DEFAULT_TAB: SettingsTabId = 'account';

export const SETTINGS_TAB_CONFIGS: SettingsTabConfig[] = [
  {
    id: 'account',
    section: 'account',
    labelKey: 'settings.tabs.account',
    descriptionKey: 'settings.categories.account.description',
    icon: UserRound,
    capability: 'cloudAccount',
    path: '/$workspaceName/settings/account',
  },
  {
    id: 'preferences',
    section: 'personal',
    labelKey: 'settings.tabs.preferences',
    descriptionKey: 'settings.categories.preferences.description',
    icon: SlidersHorizontal,
    path: '/$workspaceName/settings/preferences',
  },
  {
    id: 'appearance',
    section: 'personal',
    labelKey: 'settings.tabs.appearance',
    descriptionKey: 'settings.categories.appearance.description',
    icon: Palette,
    path: '/$workspaceName/settings/appearance',
  },
  {
    id: 'keyboard-shortcuts',
    section: 'personal',
    labelKey: 'settings.tabs.keyboardShortcuts',
    descriptionKey: 'settings.categories.keyboardShortcuts.description',
    icon: Keyboard,
    path: '/$workspaceName/settings/keyboard-shortcuts',
  },
  {
    id: 'workspace',
    section: 'workspace',
    labelKey: 'settings.tabs.workspaceGeneral',
    descriptionKey: 'settings.categories.workspace.description',
    icon: Building2,
    capability: 'cloudAccount',
    path: '/$workspaceName/settings/workspace',
  },
  {
    id: 'machines',
    section: 'workspace',
    labelKey: 'settings.tabs.machines',
    descriptionKey: 'settings.categories.machines.description',
    icon: Monitor,
    multiMemberOnly: true,
    path: '/$workspaceName/settings/machines',
  },
  {
    id: 'agents',
    section: 'workspace',
    labelKey: 'settings.tabs.agents',
    descriptionKey: 'settings.categories.agents.description',
    icon: Bot,
    path: '/$workspaceName/settings/agents',
  },
  {
    // Beside Agents on purpose: a provider says how an agent starts, a Role
    // says how one is used, and the two must not read as one editor.
    id: 'agent-roles',
    section: 'workspace',
    labelKey: 'settings.tabs.agentRoles',
    descriptionKey: 'settings.categories.agentRoles.description',
    icon: UserRoundCog,
    path: '/$workspaceName/settings/agent-roles',
  },
  {
    id: 'mcp',
    section: 'workspace',
    labelKey: 'settings.tabs.mcp',
    descriptionKey: 'settings.categories.mcp.description',
    icon: Plug,
    path: '/$workspaceName/settings/mcp',
  },
  {
    id: 'prompt-shortcuts',
    section: 'workspace',
    labelKey: 'settings.tabs.promptShortcuts',
    descriptionKey: 'settings.categories.promptShortcuts.description',
    icon: FileText,
    path: '/$workspaceName/settings/prompt-shortcuts',
  },
  {
    id: 'projects',
    section: 'workspace',
    labelKey: 'settings.tabs.projects',
    descriptionKey: 'settings.categories.projects.description',
    icon: FolderOpen,
    path: '/$workspaceName/settings/projects',
  },
  {
    id: 'github',
    section: 'workspace',
    labelKey: 'settings.tabs.github',
    descriptionKey: 'settings.categories.github.description',
    icon: Github,
    capability: 'githubIntegration',
    path: '/$workspaceName/settings/github',
  },
  {
    id: 'ai-usage',
    section: 'workspace',
    labelKey: 'settings.tabs.aiUsage',
    descriptionKey: 'settings.categories.aiUsage.description',
    icon: ChartNoAxesCombined,
    capability: 'usageAnalytics',
    path: '/$workspaceName/settings/ai-usage',
  },
  {
    id: 'billing',
    section: 'workspace',
    labelKey: 'settings.tabs.billing',
    descriptionKey: 'settings.categories.billing.description',
    icon: CreditCard,
    capability: 'billing',
    path: '/$workspaceName/settings/billing',
  },
  {
    id: 'about',
    section: 'other',
    labelKey: 'settings.tabs.about',
    descriptionKey: 'settings.categories.about.description',
    icon: Info,
    path: '/$workspaceName/settings/about',
  },
];

export function useVisibleSettingsTabs(options?: {
  includeMultiMemberOnly?: boolean;
}): SettingsTabConfig[] {
  const hasCapability = useAppCapabilityCheck();
  const includeMultiMemberOnly = options?.includeMultiMemberOnly ?? true;
  return SETTINGS_TAB_CONFIGS.filter(
    (tab) =>
      (tab.capability === undefined || hasCapability(tab.capability)) &&
      (!tab.multiMemberOnly || includeMultiMemberOnly)
  );
}

export function getActiveSettingsTabId(pathname: string): SettingsTabId | null {
  const suffixes: Array<[string, SettingsTabId]> = [
    ['/settings/account', 'account'],
    ['/settings/preferences', 'preferences'],
    ['/settings/general', 'preferences'],
    ['/settings/appearance', 'appearance'],
    ['/settings/keyboard-shortcuts', 'keyboard-shortcuts'],
    ['/settings/my-machines', 'machines'],
    ['/settings/workspace', 'workspace'],
    ['/settings/people', 'workspace'],
    ['/settings/machines', 'machines'],
    ['/settings/devices', 'machines'],
    ['/settings/agents', 'agents'],
    ['/settings/agent-config', 'agents'],
    ['/settings/agent-roles', 'agent-roles'],
    ['/settings/prompt-shortcuts', 'prompt-shortcuts'],
    ['/settings/mcp', 'mcp'],
    ['/settings/projects', 'projects'],
    ['/settings/github', 'github'],
    ['/settings/ai-usage', 'ai-usage'],
    ['/settings/stats', 'ai-usage'],
    ['/settings/billing', 'billing'],
    ['/settings/about', 'about'],
  ];
  return suffixes.find(([suffix]) => pathname.endsWith(suffix))?.[1] ?? null;
}
