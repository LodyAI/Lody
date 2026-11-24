// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initI18n } from '../src/i18n';
import {
  PluginProposalCard,
  type PluginReview,
} from '../src/components/ai-gui/plugin-proposal-card';
const r: PluginReview = {
  status: 'pending',
  action: 'update',
  requestId: 'req',
  pluginId: 'charts',
  source: 'package.lodypkg',
  digest: 'ab'.repeat(32),
  workspaceId: 'w',
  sessionId: 's',
  machineId: 'target-machine',
  expiresAt: Date.UTC(2030, 0, 1),
  capabilities: ['client', 'machine'],
  added: ['machine'],
  removed: ['styles'],
};
let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  await initI18n('en');
  vi.useFakeTimers();
  vi.setSystemTime(r.expiresAt - 1000);
  node = document.createElement('div');
  root = createRoot(node);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.useRealTimers();
});
it('shows the frozen target and capability changes; only a human click submits and the recorded decision wins on replay', async () => {
  const calls: string[] = [];
  const reply = Promise.withResolvers<'rejected'>();
  await act(() =>
    root.render(
      <PluginProposalCard
        review={r}
        decide={(choice) => {
          calls.push(choice);
          return reply.promise;
        }}
      />
    )
  );
  for (const value of [
    r.digest,
    r.machineId,
    r.source,
    'New capabilities',
    'Removed capabilities',
    'styles',
  ])
    expect(node.textContent).toContain(value);
  expect(calls).toEqual([]);
  await act(() => {
    const approve = node.querySelector('button')!;
    approve.click();
    approve.click();
  });
  expect(calls).toEqual(['approved']);
  await act(() => reply.resolve('rejected'));
  expect(node.textContent).toContain('Rejected');
  expect(node.querySelector('button')).toBeNull();
});
it('withdraws both decisions at expiry and offers no actions in read-only review', async () => {
  const calls: string[] = [];
  await act(() => root.render(<PluginProposalCard review={r} />));
  expect(node.querySelector('button')).toBeNull();
  await act(() =>
    root.render(
      <PluginProposalCard
        review={r}
        decide={async (decision) => {
          calls.push(decision);
          return decision;
        }}
      />
    )
  );
  expect(node.querySelectorAll('button')).toHaveLength(2);
  await act(() => vi.advanceTimersByTime(1000));
  expect(node.textContent).toContain('Expired');
  expect(node.querySelector('button')).toBeNull();
  expect(calls).toEqual([]);
});
it('rejects without approving and does not offer a decision again on transcript replay', async () => {
  const choices: string[] = [];
  const decide = async (choice: 'approved' | 'rejected') => {
    choices.push(choice);
    return choice;
  };
  await act(() => root.render(<PluginProposalCard review={r} decide={decide} />));
  await act(() =>
    Array.from(node.querySelectorAll('button'))
      .find((b) => b.textContent === 'Reject')!
      .click()
  );
  expect(choices).toEqual(['rejected']);
  await act(() =>
    root.render(<PluginProposalCard review={{ ...r, status: 'rejected' }} decide={decide} />)
  );
  expect(node.textContent).toContain('Rejected');
  expect(node.querySelector('button')).toBeNull();
});

const host = vi.hoisted(() => ({ workspaceId: 'w', requestPlugin: vi.fn() }));
vi.mock('@/atoms/local-probe', async () => ({
  localProbeResultAtom: (await import('jotai')).atom({
    ok: true,
    machineId: 'target-machine',
    workspaceId: 'w',
  }),
}));
vi.mock('@/atoms/runtime', async () => ({
  activeWorkspaceRuntimeAtom: (await import('jotai')).atom(host),
}));
vi.mock('@/lib/e2ee-account', () => ({ useWorkspaceLocalAccountId: () => 'owner' }));
vi.mock('@/hooks/use-online-machines', () => ({
  useOnlineMachines: () => [{ id: 'target-machine', ownerUserId: 'owner' }],
}));
vi.mock('@/plugins/client-host-provider', () => ({ useWorkspaceClientPlugins: () => null }));
it('binds the system turn to its session and forwards only its frozen artifact to the human decision port', async () => {
  const { PluginProposalNotice } = await import('../src/components/ai-gui/plugin-proposal-notice');
  const meta = {
    workspaceId: 'w',
    machineId: r.machineId,
    sessionId: 's',
    requesterUserId: 'requester',
    expiresAt: r.expiresAt,
    status: 'pending' as const,
    command: {
      action: 'propose_enable' as const,
      requestId: 'req',
      packagePath: 'release.lodypkg',
    },
    artifact: {
      pluginId: 'sample',
      version: '1',
      title: 'Sample',
      sha256: r.digest,
      requestedCapabilities: ['machine'],
    },
  };
  const render = (entryId: string) =>
    act(() =>
      root.render(
        <PluginProposalNotice
          sessionId={'s' as import('@lody/shared').SessionId}
          entryId={entryId}
          meta={meta}
        />
      )
    );
  await render('other-turn');
  expect(node.querySelector('button')).toBeNull();
  await render('plugin-proposal-req');
  expect(host.requestPlugin).not.toHaveBeenCalled();
  host.requestPlugin.mockResolvedValue({ type: 'plugin/proposal-decision', status: 'superseded' });
  await act(() => node.querySelector('button')!.click());
  expect(host.requestPlugin).toHaveBeenCalledWith(
    r.machineId,
    {
      method: 'plugin/proposal-decision',
      params: { sessionId: 's', requestId: 'req', sha256: r.digest, decision: 'approve' },
    },
    { requireLocal: true }
  );
  expect(node.textContent).toContain('Superseded');
  expect(node.querySelector('button')).toBeNull();
});
