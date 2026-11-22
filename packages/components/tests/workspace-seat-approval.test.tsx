// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { CloudApi, PlatformProvider } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { TEST_CLOUD_PLATFORM, TestOrdinaryWorkspaceProvider } from './test-platform';
import { WorkspaceJoinRequestsSettings } from '../src/components/settings/workspace-join-requests-settings';
import { initI18n } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
let root: Root;
let container: HTMLDivElement;
const approve = vi.fn(async () => ({}));
const refresh = vi.fn(async () => ({}));
let membershipVersion: string | undefined;
let serverMembers: string[];
let refreshRosterFails: boolean;
let refreshRosterGate: Promise<void> | undefined;
beforeEach(async () => {
  await initI18n('en');
  approve.mockClear();
  refresh.mockClear();
  approve.mockImplementation(async () => {
    serverMembers = ['Owner', 'Member'];
    return {};
  });
  membershipVersion = undefined;
  serverMembers = ['Owner'];
  refreshRosterFails = false;
  refreshRosterGate = undefined;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
function OwnerSettings() {
  const [members, setMembers] = useState(['Owner']);
  return (
    <>
      <p data-testid="ordinary-member-list">{members.join(', ')}</p>
      <WorkspaceJoinRequestsSettings
        workspaceId="workspace"
        onMembersChanged={async () => {
          const snapshot = [...serverMembers];
          await refreshRosterGate;
          if (refreshRosterFails) throw new Error('temporary cache refresh failure');
          setMembers(snapshot);
        }}
      />
    </>
  );
}
async function renderOwner() {
  const platform: PlatformProvider = {
    ...TEST_CLOUD_PLATFORM,
    cloudApi: {
      useQuery: ((operation: { name: string }) =>
        operation.name.includes('getOwnerState')
          ? {
              membershipVersion,
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
      <TestOrdinaryWorkspaceProvider workspaceId="workspace">
        <PlatformContext.Provider value={platform}>
          <OwnerSettings />
        </PlatformContext.Provider>
      </TestOrdinaryWorkspaceProvider>
    )
  );
}
const memberList = () =>
  container.querySelector('[data-testid="ordinary-member-list"]')?.textContent;
it('shows the deferred fee and refreshes the ordinary member list only after approval commits', async () => {
  await renderOwner();
  expect(memberList()).toBe('Owner');
  await act(async () =>
    (document.querySelector('button[aria-label="Approve"]') as HTMLButtonElement).click()
  );
  expect(refresh).not.toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('$57.41');
  expect(document.body.textContent).toContain('They get access right away');
  const confirm = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Approve'
  )!;
  await act(async () => confirm.click());
  expect(refresh).toHaveBeenCalledOnce();
  expect(approve).toHaveBeenCalledWith({ requestId: 'request', decision: 'approved' });
  expect(memberList()).toBe('Owner, Member');
});

it('refreshes the cached ordinary roster on open and on remote version changes without another subscription', async () => {
  membershipVersion = 'version-1';
  serverMembers = ['Owner', 'Already approved elsewhere'];
  await renderOwner();
  expect(memberList()).toBe('Owner, Already approved elsewhere');
  serverMembers = ['Owner', 'Already approved elsewhere', 'New remote member'];
  await renderOwner();
  expect(memberList()).toBe('Owner, Already approved elsewhere');
  membershipVersion = 'version-2';
  await renderOwner();
  expect(memberList()).toBe('Owner, Already approved elsewhere, New remote member');
});

it('keeps a committed approval successful when the member cache refresh fails, then recovers', async () => {
  refreshRosterFails = true;
  await renderOwner();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Approve"]')!.click()
  );
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (button) => button.textContent === 'Approve'
  )!;
  await act(async () => confirm.click());
  expect(serverMembers).toEqual(['Owner', 'Member']);
  expect(memberList()).toBe('Owner');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  refreshRosterFails = false;
  membershipVersion = 'version-after-reconnect';
  await renderOwner();
  expect(memberList()).toBe('Owner, Member');
});

it('refreshes again when membership changes during an older roster read', async () => {
  membershipVersion = 'version-1';
  const pending = Promise.withResolvers<void>();
  refreshRosterGate = pending.promise;
  await renderOwner();
  serverMembers = ['Owner', 'Approved during the old read'];
  membershipVersion = 'version-2';
  await renderOwner();
  expect(memberList()).toBe('Owner');
  refreshRosterGate = undefined;
  await act(async () => pending.resolve());
  expect(memberList()).toBe('Owner, Approved during the old read');
});
