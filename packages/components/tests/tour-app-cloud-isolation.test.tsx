// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformProvider } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

vi.mock('../src/components/loro-sidebar', () => ({
  LoroSidebar: () => null,
}));

vi.mock('../src/components/sessions/desktop-session-detail-layout', () => ({
  DesktopSessionDetailLayout: ({ chatSurfaces }: { chatSurfaces: ReactNode }) => chatSurfaces,
}));

vi.mock('../src/components/sessions/session-conversation-page', () => ({
  SessionConversationPage: ({ bodySlot }: { bodySlot: ReactNode }) => bodySlot,
  SessionConversationPageBody: ({ composerSlot }: { composerSlot: ReactNode }) => composerSlot,
}));

// Keep the regression probe at the exact production seam that originally
// escaped: TourApp's reused composer asking for visibility data. The rest of
// the heavy product chrome is irrelevant to this provider-wiring assertion.
vi.mock('../src/components/sessions/session-chat-input-area', async () => {
  const [{ createElement, forwardRef }, { useCloudQuery }, { cloudOperations }, fixtures] =
    await Promise.all([
      import('react'),
      import('@lody/platform/react'),
      import('../src/lib/cloud-api-operations'),
      import('../src/components/onboarding/tour/tour-fixtures'),
    ]);

  return {
    SessionChatInputArea: forwardRef(function TourComposerCloudProbe() {
      const machines = useCloudQuery(cloudOperations.machines.listVisibleMachines, {
        workspaceId: fixtures.TOUR_WORKSPACE_ID,
      });
      const localProjects = useCloudQuery(cloudOperations.localProjects.listVisibleLocalProjects, {
        workspaceId: fixtures.TOUR_WORKSPACE_ID,
      });

      return createElement(
        'div',
        { 'data-testid': 'tour-composer-cloud-probe' },
        `${machines?.[0]?.machineId ?? 'missing'}:${localProjects?.[0]?.localProjectId ?? 'missing'}`
      );
    }),
  };
});

vi.mock('../src/components/terminal/terminal-dock', () => ({
  TerminalDock: () => null,
}));

import { TourApp, type TourAppTracks } from '../src/components/onboarding/tour/tour-app';
import {
  TOUR_LOCAL_PROJECT_ID,
  TOUR_MACHINE_ID,
} from '../src/components/onboarding/tour/tour-fixtures';
import { TEST_CLOUD_PLATFORM } from './test-platform';

const TRACKS: TourAppTracks = {
  reveal: 0,
  tasks: 0,
  archived: 0,
  childTabs: 0,
  subagents: 0,
  panel: 0,
  changes: 0,
  terminal: 0,
  annotation: 0,
  pr: 0,
  typing: 0,
};

describe('TourApp cloud isolation wiring', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('keeps composer visibility reads off the authenticated outer cloud adapter', async () => {
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
        <PlatformContext.Provider value={outerPlatform}>
          <TourApp
            tracks={TRACKS}
            permissionAnswer={null}
            onPermissionAnswer={vi.fn()}
            activeSidePanelTab="changes"
            onSidePanelTabSelect={vi.fn()}
            selectedTaskId="tour-1"
            activeTabIndex={0}
            onSelectTabIndex={vi.fn()}
          />
        </PlatformContext.Provider>
      );
    });

    expect(container.querySelector('[data-testid="tour-composer-cloud-probe"]')?.textContent).toBe(
      `${TOUR_MACHINE_ID}:${TOUR_LOCAL_PROJECT_ID}`
    );
    expect(useOuterCloudQuery).not.toHaveBeenCalled();
  });
});
