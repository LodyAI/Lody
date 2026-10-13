// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceJoinRequestsSettings } from '../src/components/settings/workspace-join-requests-settings';
import { initI18n } from '../src/i18n';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  mutation: vi.fn(),
  action: vi.fn(),
}));

vi.mock('@lody/platform/react', () => ({
  useCloudMutation: () => mocks.mutation,
  useCloudAction: () => mocks.action,
  useCloudQuery: (...args: unknown[]) => mocks.useQuery(...args),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('WorkspaceJoinRequestsSettings', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('shows when each pending request was submitted', async () => {
    const createdAt = Date.UTC(2026, 7, 6, 10, 30);
    mocks.useQuery.mockReturnValue({
      activeLink: null,
      pendingRequests: [
        {
          id: 'request_1',
          applicantName: 'Student',
          applicantEmail: 'student@example.com',
          reason: 'Research project',
          createdAt,
        },
      ],
      hasMorePendingRequests: false,
    });

    await act(async () => {
      root.render(<WorkspaceJoinRequestsSettings workspaceId="workspace_1" />);
    });

    const formattedDate = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(createdAt));
    expect(container.textContent).toContain(`Requested ${formattedDate}`);
  });
});
