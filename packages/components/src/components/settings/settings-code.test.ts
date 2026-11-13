import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  evaluated: [] as string[],
  mounted: [] as string[],
  offline: false,
}));
function registerMocks() {
  vi.doMock('./general-setting', () => {
    state.evaluated.push('preferences');
    return {
      get GeneralSettingsComponent() {
        if (state.offline) throw new Error('panel unavailable');
        return () => {
          state.mounted.push('preferences');
          return null;
        };
      },
    };
  });
  vi.doMock('./desktop-settings-modal', () => {
    state.evaluated.push('modal');
    return {
      DesktopSettingsModal: () => {
        state.mounted.push('modal');
        return null;
      },
    };
  });
  vi.doMock('./mcp-setting', () => {
    state.evaluated.push('mcp');
    return { McpSetting: () => null };
  });
}

beforeEach(() => {
  vi.resetModules();
  registerMocks();
  state.evaluated.length = 0;
  state.mounted.length = 0;
  state.offline = false;
});

it('warms only the requested desktop panel and shell without mounting either', async () => {
  const code = await import('./settings-code');
  await code.preloadSettings('preferences');
  expect(state.evaluated.sort()).toEqual(['modal', 'preferences']);
  expect(state.mounted).toEqual([]);
  const opening = code.loadGeneralSettingsComponent();
  expect(code.preloadSettingsPanel('preferences')).toBe(opening);
  expect(await opening).toHaveProperty('default');
});

it('mobile intent warms its panel without fetching the desktop modal', async () => {
  const code = await import('./settings-code');
  await code.preloadSettings('preferences', true);
  expect(state.evaluated).toEqual(['preferences']);
  expect(state.mounted).toEqual([]);
});

it('lets the real panel loader retry after speculative preparation fails', async () => {
  const code = await import('./settings-code');
  state.offline = true;
  await expect(code.preloadSettings('preferences', true)).rejects.toThrow('panel unavailable');
  state.offline = false;
  expect(await code.loadGeneralSettingsComponent()).toHaveProperty('default');
  expect(state.mounted).toEqual([]);
});
