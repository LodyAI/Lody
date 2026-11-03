// @vitest-environment jsdom

import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformProvider } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';

vi.mock('../src/components/sessions/desktop-session-detail-layout', () => ({
  DesktopSessionDetailLayout: ({ chatSurfaces }: { chatSurfaces: ReactNode }) => chatSurfaces,
}));
vi.mock('../src/components/terminal/terminal-dock', () => ({ TerminalDock: () => null }));

import { TourApp, type TourAppTracks } from '../src/components/onboarding/tour/tour-app';
import { WorkspaceRouteTargetProvider } from '../src/providers/workspace-route-target';
import { initI18n } from '../src/i18n';
import { TEST_CLOUD_PLATFORM } from './test-platform';

const TRACKS: TourAppTracks = {
  reveal: 9,
  tasks: 4,
  archived: 0,
  childTabs: 1,
  subagents: 0,
  panel: 0,
  changes: 0,
  terminal: 0,
  annotation: 0,
  pr: 0,
  typing: 0,
};

describe('TourApp real composer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    HTMLElement.prototype.scrollIntoView = () => {};
    await import('../src/components/ai-gui/markdown-math-copy');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('supplies composer visibility and empty prompt suggestions inside the tour boundary', async () => {
    const useOuterCloudQuery = vi.fn(() => {
      throw new Error('Tour query escaped to the authenticated app cloud adapter');
    });
    const outerPlatform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      cloudApi: {
        ...TEST_CLOUD_PLATFORM.cloudApi!,
        useQuery: useOuterCloudQuery,
      },
    };

    await act(async () => {
      root.render(
        <StrictMode>
          <PlatformContext.Provider value={outerPlatform}>
            <WorkspaceRouteTargetProvider slug="vault">
              <TourApp
                tracks={TRACKS}
                configurationState={{
                  step: 'workspace',
                  workspaceStatus: 'ready',
                  agentStatus: 'missing',
                  projectStatus: 'missing',
                  promptValue: '',
                  conversationStatus: 'empty',
                }}
                permissionAnswer={null}
                onPermissionAnswer={vi.fn()}
                activeSidePanelTab="changes"
                onSidePanelTabSelect={vi.fn()}
                selectedTaskId="tour-1"
                activeTabIndex={0}
                onSelectTabIndex={vi.fn()}
              />
            </WorkspaceRouteTargetProvider>
          </PlatformContext.Provider>
        </StrictMode>
      );
    });

    expect(container.querySelector('textarea')).not.toBeNull();
    expect(useOuterCloudQuery).not.toHaveBeenCalled();
  });
});
