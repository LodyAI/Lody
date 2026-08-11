import { describe, expect, it } from 'vitest';

import {
  getActiveSettingsTabId,
  SETTINGS_DEFAULT_TAB,
  SETTINGS_TAB_CONFIGS,
} from '../src/components/settings/settings-tabs';

describe('SETTINGS_TAB_CONFIGS', () => {
  it('groups personal and workspace settings in the approved order', () => {
    expect(SETTINGS_TAB_CONFIGS.map((tab) => tab.id)).toEqual([
      'account',
      'preferences',
      'appearance',
      'keyboard-shortcuts',
      'workspace',
      'machines',
      'agents',
      'projects',
      'github',
      'ai-usage',
      'billing',
      'about',
    ]);
  });

  it('opens Account by default and has no separate My Machines tab', () => {
    expect(SETTINGS_DEFAULT_TAB).toBe('account');
    expect(SETTINGS_TAB_CONFIGS.find((tab) => tab.id === 'account')?.section).toBe('account');
    expect(SETTINGS_TAB_CONFIGS.map((tab) => String(tab.id))).not.toContain('my-machines');
  });

  it('marks only workspace Machines as team-only', () => {
    expect(SETTINGS_TAB_CONFIGS.find((tab) => tab.id === 'machines')).toMatchObject({
      section: 'workspace',
      multiMemberOnly: true,
    });
    expect(SETTINGS_TAB_CONFIGS.filter((tab) => tab.multiMemberOnly).map((tab) => tab.id)).toEqual([
      'machines',
    ]);
  });

  it('resolves canonical and legacy settings paths to the new destinations', () => {
    expect(getActiveSettingsTabId('/acme/settings/my-machines')).toBe('machines');
    expect(getActiveSettingsTabId('/acme/settings/agents')).toBe('agents');
    expect(getActiveSettingsTabId('/acme/settings/ai-usage')).toBe('ai-usage');
    expect(getActiveSettingsTabId('/acme/settings/general')).toBe('preferences');
    expect(getActiveSettingsTabId('/acme/settings/people')).toBe('workspace');
    expect(getActiveSettingsTabId('/acme/settings/devices')).toBe('machines');
    expect(getActiveSettingsTabId('/acme/settings/agent-config')).toBe('agents');
    expect(getActiveSettingsTabId('/acme/settings/stats')).toBe('ai-usage');
  });
});
