// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { CloudApi, PlatformProvider } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { TEST_CLOUD_PLATFORM } from './test-platform';
import { WorkspaceJoinRequestsSettings } from '../src/components/settings/workspace-join-requests-settings';
import { initI18n } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
let root: Root;
let container: HTMLDivElement;
const approve = vi.fn(async () => ({}));
const refresh = vi.fn(async () => ({}));
beforeEach(async () => {
  await initI18n('en');
  approve.mockClear();
  refresh.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it('shows the deferred fee before approving membership', async () => {
  const platform: PlatformProvider = {
    ...TEST_CLOUD_PLATFORM,
    cloudApi: {
      useQuery: ((operation: { name: string }) =>
        operation.name.includes('getOwnerState')
          ? {
              activeLink: null,
              pendingRequests: [
                {
                  id: 'request',
                  name: 'Member',
                  email: 'member@example.com',
                  reason: 'Join',
                  createdAt: 1790000000000,
                },
              ],
              hasMorePendingRequests: false,
            }
          : {
              status: 'billed',
              interval: 'year',
              unitAmount: 9600,
              proratedAmount: 5741,
              currentPeriodEnd: null,
              seatCount: 1,
              nextSeatCount: 2,
              nextRenewalAmount: null,
              currency: 'usd',
            }) as CloudApi['useQuery'],
      useAction: (() => refresh) as CloudApi['useAction'],
      useMutation: (() => approve) as CloudApi['useMutation'],
    },
  };
  await act(async () =>
    root.render(
      <PlatformContext.Provider value={platform}>
        <WorkspaceJoinRequestsSettings workspaceId="workspace" />
      </PlatformContext.Provider>
    )
  );
  await act(async () =>
    (document.querySelector('button[aria-label="Approve"]') as HTMLButtonElement).click()
  );
  expect(refresh).toHaveBeenCalledOnce();
  expect(approve).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('$57.41');
  expect(document.body.textContent).toContain('They get access right away');
  const confirm = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Approve'
  )!;
  await act(async () => confirm.click());
  expect(approve).toHaveBeenCalledWith({ requestId: 'request', decision: 'approved' });
});
