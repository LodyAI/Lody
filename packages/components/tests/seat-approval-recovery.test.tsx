// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initI18n } from '../src/i18n';
const io = vi.hoisted(() => ({
  refresh: vi.fn(),
  review: vi.fn(),
  paymentAction: undefined as 'payment_required' | undefined,
}));
vi.mock('../src/hooks/use-legacy-workspace-query', () => ({
  useLegacyWorkspaceQuery: () => ({
    activeLink: null,
    pendingRequests: [
      {
        id: 'r1',
        applicantName: 'Member',
        applicantEmail: 'member@example.test',
        reason: 'Join',
        createdAt: 1,
      },
    ],
    hasMorePendingRequests: false,
  }),
  useLegacyWorkspaceMutation: () => io.review,
}));
vi.mock('@lody/platform/react', () => ({
  useCloudAction: () => io.refresh,
  useCloudQuery: () => ({
    status: 'billed',
    proratedAmount: 500,
    interval: 'month',
    unitAmount: 1000,
    currentPeriodEnd: 1800000000000,
    seatCount: 1,
    nextSeatCount: 2,
    nextRenewalAmount: 2000,
    paymentAction: io.paymentAction,
  }),
}));
import { WorkspaceJoinRequestsSettings } from '../src/components/settings/workspace-join-requests-settings';
let root: Root, host: HTMLDivElement;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(async () => {
  await initI18n('en');
  io.paymentAction = undefined;
  io.review.mockReset().mockResolvedValue({});
  io.refresh.mockReset().mockResolvedValue({ status: 'ready' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function open() {
  await act(async () =>
    root.render(<WorkspaceJoinRequestsSettings workspaceId="w" onOpenBilling={() => {}} />)
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Approve"]')!.click()
  );
}
it('refreshes payment at the actual approval click and waits for it before admitting', async () => {
  let finish!: () => void;
  io.refresh.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  await open();
  expect(io.refresh).not.toHaveBeenCalled();
  const approve = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (button) => button.textContent === 'Approve'
  )!;
  await act(async () => approve.click());
  expect(io.refresh).toHaveBeenCalledOnce();
  expect(io.review).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(io.review).toHaveBeenCalledWith({ requestId: 'r1', decision: 'approved' });
});
it('blocks approval when debt is already known and offers recovery in the same dialog', async () => {
  io.paymentAction = 'payment_required';
  await open();
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
  expect(buttons.find((button) => button.textContent === 'Approve')?.disabled).toBe(true);
  expect(buttons.find((button) => button.textContent === 'Go to billing to pay')?.disabled).toBe(
    false
  );
  expect(io.review).not.toHaveBeenCalled();
});
