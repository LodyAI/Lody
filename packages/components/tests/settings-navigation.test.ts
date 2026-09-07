import { describe, expect, it } from 'vitest';
import { getSettingsBackDestination, resolveSettingsCloseTo } from '../src/lib/settings-navigation';

describe('settings navigation', () => {
  it('restores the full source path when leaving the top-level mobile settings page', () => {
    expect(
      getSettingsBackDestination({
        isMobile: true,
        settingsListPage: true,
        from: '/acme/chat?context=local&machine=machine-1&project=project-1',
      })
    ).toEqual({
      kind: 'source',
      to: '/acme/chat?context=local&machine=machine-1&project=project-1',
    });

    expect(
      getSettingsBackDestination({
        isMobile: true,
        settingsListPage: true,
        from: '/acme/chat?context=github&repo=LodyAI%2FLody',
      })
    ).toEqual({
      kind: 'source',
      to: '/acme/chat?context=github&repo=LodyAI%2FLody',
    });
  });

  it('returns nested mobile settings pages to the settings list first', () => {
    expect(
      getSettingsBackDestination({
        isMobile: true,
        settingsListPage: false,
        from: '/acme/chat?context=local',
      })
    ).toEqual({ kind: 'settings-list' });
  });

  it('falls back to chat when the source is absent or unsafe', () => {
    expect(getSettingsBackDestination({ isMobile: true, settingsListPage: true })).toEqual({
      kind: 'chat',
    });
    expect(
      getSettingsBackDestination({
        isMobile: true,
        settingsListPage: true,
        from: '//example.com/phishing',
      })
    ).toEqual({ kind: 'chat' });
  });

  it('accepts only absolute in-app source paths', () => {
    expect(resolveSettingsCloseTo('/acme/chat?context=local')).toBe('/acme/chat?context=local');
    expect(resolveSettingsCloseTo('https://example.com')).toBeNull();
    expect(resolveSettingsCloseTo('//example.com')).toBeNull();
  });
});
