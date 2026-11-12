import { ClientCustodyError } from '@lody/e2ee-core/services';
import { classifyE2eeControlFailure } from '../src/lib/e2ee-control-failure';
import { E2eeMemberActions } from '../src/components/pages/e2ee-member-actions';
// @vitest-environment jsdom

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState, type ComponentProps } from 'react';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Result } from 'effect';
import {
  encodeCbor,
  hashRecordBytes,
  recordSigningBytes,
  type CborValue,
} from '@lody/e2ee-core/protocol';
import { join } from 'node:path';
import { E2eeWorkspaceControlPage } from '../src/components/pages/e2ee-workspace-control-page';
import {
  appendLedgerHistory,
  bytesToHex,
  type VerifiedLedgerHistory,
} from '../src/lib/e2ee-ledger-history';
import { ledgerOverview } from '../src/lib/e2ee-ledger-overview';
import { ledgerVerificationCode } from '../src/lib/e2ee-ledger-verification';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

function render(overrides: Partial<ComponentProps<typeof E2eeWorkspaceControlPage>>) {
  const props: ComponentProps<typeof E2eeWorkspaceControlPage> = {
    workspaceId: 'workspace-1',
    history: null,
    loading: false,
    failure: null,
    diagnostics: () => '{"kind":"lody-e2ee-workspace-diagnostics"}',
    onRepairLocal: vi.fn(),
    onResetProgress: vi.fn(),
    onLoadMore: vi.fn(),
    onRefresh: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<E2eeWorkspaceControlPage {...props} />));
  return props;
}

const button = (label: string) =>
  [...container!.querySelectorAll('button')].find((item) => item.textContent === label);

describe('encrypted workspace control page recovery', () => {
  it('guides an unapproved portable device without offering destructive identity recovery', () => {
    render({ failure: { kind: 'approval-required', code: 'approval-required' } });
    expect(container!.textContent).toContain('e2ee.pair.desktopApprovalRequired');
    expect(container!.textContent).toContain('e2ee.pair.help');
    expect(button('e2ee.control.repairLocal')).toBeUndefined();
    expect(button('e2ee.control.resetProgress')).toBeUndefined();
  });
  it.each(['locked', 'indeterminate', 'unavailable'] as const)(
    'shows explicit %s custody guidance without destructive recovery',
    (reason) => {
      const props = render({
        failure: classifyE2eeControlFailure(new ClientCustodyError({ reason })),
      });
      expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
        `e2ee.custody.${reason}.title`
      );
      expect(container!.textContent).toContain(`e2ee.custody.${reason}.help`);
      expect(container!.textContent).not.toContain('e2ee.control.status.unreachable');
      expect(button('e2ee.control.repairLocal')).toBeUndefined();
      expect(button('e2ee.control.resetProgress')).toBeUndefined();
      expect(props.onRepairLocal).not.toHaveBeenCalled();
      expect(props.onResetProgress).not.toHaveBeenCalled();
    }
  );

  it('requires a second confirmation before resetting observed history progress', () => {
    const props = render({ failure: { kind: 'progress-conflict', code: 'rolled-back' } });
    expect(container!.textContent).toContain('e2ee.control.failure.progressConflict');
    act(() => button('e2ee.control.resetProgress')!.click());
    expect(props.onResetProgress).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('e2ee.control.resetProgressWarning');
    act(() => button('e2ee.control.resetProgressConfirm')!.click());
    expect(props.onResetProgress).toHaveBeenCalledTimes(1);
  });

  it('offers no local reset for an identity conflict and repair only for unreadable caches', () => {
    render({ failure: { kind: 'identity-conflict', code: 'pin-mismatch' } });
    expect(button('e2ee.control.resetProgress')).toBeUndefined();
    expect(button('e2ee.control.repairLocal')).toBeUndefined();
    expect(button('e2ee.control.copyDiagnostics')).toBeDefined();
    act(() => root?.unmount());
    const props = render({
      failure: { kind: 'local-corrupt', code: 'Invalid workspace mode proof' },
    });
    act(() => button('e2ee.control.repairLocal')!.click());
    expect(props.onRepairLocal).toHaveBeenCalledTimes(1);
  });

  it('gives each failure one next step that does something, with diagnostics secondary', () => {
    const tab = () =>
      container!
        .querySelector('[aria-current="page"][data-console-tab]')
        ?.getAttribute('data-console-tab');
    render({ failure: { kind: 'local-identity', code: 'missing' } });
    expect(container!.textContent).toContain('e2ee.failure.identity.title');
    act(() => button('e2ee.failure.action.devices')!.click());
    expect(tab()).toBe('devices');
    act(() => button('e2ee.failure.action.recovery')!.click());
    expect(tab()).toBe('recovery');
    act(() => root?.unmount());

    // An update is offered only where the host can check for one.
    render({ failure: { kind: 'upgrade', code: 'capability' } });
    expect(button('e2ee.failure.action.update')).toBeUndefined();
    expect(button('e2ee.control.copyDiagnostics')).toBeDefined();
    act(() => root?.unmount());
    const onCheckForUpdates = vi.fn();
    render({ failure: { kind: 'upgrade', code: 'capability' }, onCheckForUpdates });
    act(() => button('e2ee.failure.action.update')!.click());
    expect(onCheckForUpdates).toHaveBeenCalledTimes(1);
    act(() => root?.unmount());

    const props = render({
      failure: classifyE2eeControlFailure(new ClientCustodyError({ reason: 'locked' })),
    });
    act(() => button('e2ee.failure.action.refresh')!.click());
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows the diagnostics report when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    render({ failure: { kind: 'server', code: 'bad-signature' } });
    await act(async () => {
      button('e2ee.control.copyDiagnostics')!.click();
      await Promise.resolve();
    });
    expect(container!.querySelector('details')?.open).toBe(true);
    expect(container!.textContent).toContain('lody-e2ee-workspace-diagnostics');
  });
});

describe('encrypted workspace control page reading', () => {
  // Frozen synthetic ledger v1 vector signed by fixed test keys.
  const vector = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../e2ee-core/test/ledger-v1-vector.json'), 'utf8')
  ) as { anchor: string; records: { hex: string; hash: string }[] };
  const page = (count: number, headHash: string) => ({
    workspaceId: 'w',
    genesisHash: vector.anchor,
    checkpoint: { headHash, length: count },
    startIndex: 0,
    nextCursor: null,
    recordsHex: vector.records.slice(0, count).map((record) => record.hex),
  });
  const expected = (localPin: string | null) => ({
    workspaceId: 'w',
    genesisHash: vector.anchor,
    localPin,
  });
  // Append an unsupported capability record signed by Carol (the current Owner at vector end).
  const carolKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, 3),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const carolPublicKey = new Uint8Array(
    createPublicKey(carolKey).export({ format: 'der', type: 'spki' }).subarray(-32)
  );
  const futureBody: CborValue = [
    new Uint8Array(Buffer.from(vector.records.at(-1)!.hash, 'hex')),
    carolPublicKey,
    [9, [3]],
  ];
  const futureBodyBytes = Result.getOrThrow(encodeCbor(futureBody));
  const futureRecord = Result.getOrThrow(
    encodeCbor([
      futureBody,
      new Uint8Array(sign(null, recordSigningBytes(futureBodyBytes), carolKey)),
    ])
  );
  const futureHash = bytesToHex(hashRecordBytes(futureRecord).toBytes());
  const full = appendLedgerHistory(
    null,
    {
      ...page(vector.records.length, vector.records.at(-1)!.hash),
      checkpoint: { headHash: futureHash, length: vector.records.length + 1 },
      recordsHex: [...vector.records.map((record) => record.hex), bytesToHex(futureRecord)],
    },
    expected(vector.anchor)
  );
  const history = (localPin: string | null) =>
    appendLedgerHistory(null, page(11, full.records[10]!.hash), expected(localPin));

  it('names the genesis member after this account only when this device holds the pin', () => {
    const you = { name: 'Alex Chen' };
    const profiles = new Map([['03'.repeat(32), { name: 'Jordan Lee' }]]);
    render({ history: history(vector.anchor), you, initialTab: 'members' });
    let text = container!.textContent!;
    expect(text).toContain('Alex Chen');
    expect(text).toContain('e2ee.control.you');
    act(() =>
      (container!.querySelector('[data-console-tab="security"]') as HTMLButtonElement).click()
    );
    expect(container!.textContent).toContain('"actor":"Alex Chen"');
    act(() => root?.unmount());
    render({ history: history(null), you, memberProfiles: profiles, initialTab: 'members' });
    text = container!.textContent!;
    expect(text).not.toContain('Alex Chen');
    expect(text).toContain('Jordan Lee');
  });

  it('shows getting started only on the creating device, with recovery only when known', () => {
    render({ history: history(vector.anchor), recoveryReady: false });
    const list = () => container!.querySelector('[data-testid="e2ee-getting-started"]');
    expect(list()).not.toBeNull();
    const item = (id: string) => list()!.querySelector(`[data-start-item="${id}"]`);
    expect(item('create')?.getAttribute('data-done')).toBe('true');
    expect(item('recovery')?.getAttribute('data-done')).toBe('false');
    act(() => button('e2ee.console.start.recoveryAction')!.click());
    expect(
      container!.querySelector('[data-console-tab="recovery"]')?.getAttribute('aria-current')
    ).toBe('page');
    act(() => root?.unmount());
    render({ history: history(vector.anchor) });
    expect(list()?.querySelector('[data-start-item="recovery"]') ?? null).toBeNull();
    act(() => root?.unmount());
    // Another member's device cannot tell which member it is, so it shows no list.
    render({ history: history(null), recoveryReady: false });
    expect(list()).toBeNull();
  });

  it('maps profiles through verified crypto users without changing roles, members or verification', () => {
    const verified = history(vector.anchor);
    const before = ledgerVerificationCode(verified).stateDigest;
    const forged = { name: 'Display owner', role: 'guest', signingPublicKey: 'forged' };
    const profiles = new Map([
      ['03'.repeat(32), forged],
      ['ff'.repeat(32), { name: 'Not a ledger member' }],
    ]);
    render({
      history: verified,
      memberProfiles: profiles,
      you: { name: 'Wrong creator' },
      initialTab: 'members',
    });
    const members = container!.querySelector('section[aria-label="e2ee.control.members"]')!;
    expect(members.querySelectorAll('li')).toHaveLength(2);
    expect(members.textContent).toContain('Display owner');
    expect(members.querySelector('li')!.textContent).toContain('e2ee.values.owner');
    expect(container!.textContent).not.toContain('Not a ledger member');
    expect(container!.textContent).not.toContain('Wrong creator');
    act(() =>
      (container!.querySelector('[data-console-tab="security"]') as HTMLButtonElement).click()
    );
    expect(container!.querySelector('[aria-label="e2ee.verify.codeLabel"]')!.textContent).toBe(
      before
    );
    expect(ledgerVerificationCode(verified).stateDigest).toBe(before);
  });

  it('lets two people compare by eye when scanning is not possible, with only equal or different', async () => {
    render({ history: history(vector.anchor), initialTab: 'security' });
    const button = (label: string) =>
      [...document.body.querySelectorAll('button')].find((node) => node.textContent === label);
    await act(async () => button('e2ee.verify.scan')!.click());
    expect(document.body.textContent).toContain('e2ee.verify.showMine');
    // The dialog never asks anyone to type a code back in.
    expect(document.body.querySelector('textarea')).toBeNull();
    await act(async () => button('e2ee.verify.manualSame')!.click());
    expect(document.body.textContent).toContain('e2ee.verify.result.matchTitle');
    await act(async () => button('e2ee.verify.manualDiffer')!.click());
    expect(document.body.textContent).not.toContain('e2ee.verify.result.matchTitle');
    // By eye nobody can tell which side is older: refresh first, then stop if it persists.
    expect(document.body.textContent).toContain('e2ee.verify.result.unknownTitle');
  });

  it('reads independent removal while preserving the published epoch', () => {
    const count = vector.records.length - 1;
    const verified = appendLedgerHistory(
      null,
      page(count, vector.records[count - 1]!.hash),
      expected(vector.anchor)
    );
    render({ history: verified, initialTab: 'members' });
    expect(
      container!.querySelectorAll('section[aria-label="e2ee.control.members"] li')
    ).toHaveLength(1);
    act(() =>
      (container!.querySelector('[data-console-tab="security"]') as HTMLButtonElement).click()
    );
    expect(container!.textContent).toContain('e2ee.summary.removeMember');
    expect(verified.view.inspectState().epoch).toMatchObject({ number: 2, rotationRequired: true });
  });

  it('keeps a key update that failed after a removal on the console, with a retry that replaces the key', async () => {
    const before = history(vector.anchor);
    const count = vector.records.length - 1;
    const after = appendLedgerHistory(
      null,
      page(count, vector.records[count - 1]!.hash),
      expected(vector.anchor)
    );
    const remaining = new Set(ledgerOverview(after).members.map((member) => member.membershipId));
    const target = ledgerOverview(before).members.find(
      (member) => !remaining.has(member.membershipId)
    )!;
    expect(target.role).not.toBe('owner');
    const workspace = { removed: [] as string[], keyReplaced: 0, keyFailures: 0 };
    // Like the encryption console: a management result reloads the verified ledger, and
    // no member controls are offered while it reloads.
    function Console() {
      const [state, setState] = useState<{ history: VerifiedLedgerHistory; loading: boolean }>({
        history: before,
        loading: false,
      });
      const management = state.loading
        ? undefined
        : {
            actorRole: 'owner' as const,
            remove: async (membershipId: string) => {
              workspace.removed.push(membershipId);
              setState({ history: after, loading: true });
              await Promise.resolve();
              setState({ history: after, loading: false });
            },
            setRole: async () => {},
            rotate: async () => {
              if (workspace.keyFailures > 0) {
                workspace.keyFailures -= 1;
                throw new Error('e2ee_restart-required');
              }
              workspace.keyReplaced += 1;
            },
          };
      return (
        <E2eeWorkspaceControlPage
          workspaceId="w"
          initialTab="members"
          history={state.history}
          loading={state.loading}
          failure={null}
          memberManagement={management}
          diagnostics={() => '{}'}
          onRepairLocal={vi.fn()}
          onResetProgress={vi.fn()}
          onLoadMore={vi.fn()}
          onRefresh={vi.fn()}
          onBack={vi.fn()}
        />
      );
    }
    const notice = () => document.querySelector('[data-testid="e2ee-member-rotate-failed"]');
    const removeTarget = async (keyFailures: number) => {
      workspace.keyFailures = keyFailures;
      act(() => root?.unmount());
      container?.remove();
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
      act(() => root!.render(<Console />));
      await act(async () =>
        (
          document.querySelector(
            `[data-testid="e2ee-member-manage"][data-membership-id="${target.membershipId}"]`
          ) as HTMLButtonElement
        ).click()
      );
      await act(async () =>
        (document.querySelector('[data-testid="e2ee-member-remove"]') as HTMLElement).click()
      );
      await act(async () =>
        (
          document.querySelector('[data-testid="e2ee-member-remove-confirm"]') as HTMLButtonElement
        ).click()
      );
      expect(
        document.querySelector(
          `[data-testid="e2ee-member"][data-membership-id="${target.membershipId}"]`
        )
      ).toBeNull();
    };

    // Removal and key update both succeed: nothing extra is shown.
    await removeTarget(0);
    expect(workspace.keyReplaced).toBe(1);
    expect(notice()).toBeNull();

    // The removal commits, the key update fails, and the row is gone: the console
    // still says so in place of the generic hint, and its retry replaces the key.
    await removeTarget(2);
    expect(workspace.removed).toHaveLength(2);
    expect(notice()?.textContent).toContain('e2ee.members.rotateFailed');
    expect(document.body.textContent).not.toContain('e2ee.members.failed');
    expect(document.body.textContent).not.toContain('e2ee.members.rotationHint');
    const retry = () =>
      document.querySelector('[data-testid="e2ee-member-rotate-retry"]') as HTMLButtonElement;
    await act(async () => retry().click());
    expect(notice()?.textContent).toContain('e2ee.members.rotateRetryFailed');
    await act(async () => retry().click());
    expect(workspace.keyReplaced).toBe(2);
    expect(notice()).toBeNull();
  });

  it('stops at an unverifiable capability and asks for an upgrade instead of offering more', () => {
    render({ history: full });
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
      'e2ee.control.upgradeStop'
    );
    expect(button('e2ee.control.loadMore')).toBeUndefined();
  });
});

it('requires confirmation, carries the member incarnation, and hides forbidden member controls', async () => {
  const remove = vi.fn(async () => {}),
    setRole = vi.fn(async () => {});
  const member = {
    ordinal: 2,
    membershipId: '12'.repeat(16),
    userId: '23'.repeat(32),
    role: 'member' as const,
    devices: [],
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const show = (actorRole: 'owner' | 'admin', role: 'owner' | 'admin' | 'member') =>
    act(() =>
      root!.render(
        <E2eeMemberActions
          member={{ ...member, role }}
          name="Jordan"
          management={{ actorRole, remove, setRole }}
          onRotationSettled={() => {}}
        />
      )
    );
  show('admin', 'admin');
  expect(container.querySelector('button')).toBeNull();
  show('owner', 'owner');
  expect(container.querySelector('button')).toBeNull();
  show('owner', 'member');
  await act(async () => container!.querySelector('button')!.click());
  const action = (key: string) =>
    [...document.querySelectorAll('[role="menuitem"]')].find(
      (node) => node.textContent === key
    ) as HTMLElement;
  expect(action('e2ee.members.promote')).toBeDefined();
  expect(
    document.querySelector('[data-testid="e2ee-member-role"]')?.getAttribute('data-membership-id')
  ).toBe(member.membershipId);
  await act(async () => action('e2ee.members.remove').click());
  expect(remove).not.toHaveBeenCalled();
  expect(
    document
      .querySelector('[data-testid="e2ee-member-remove-dialog"]')
      ?.getAttribute('data-membership-id')
  ).toBe(member.membershipId);
  // The dialog states what removal cannot undo before anyone confirms.
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'e2ee.members.removeEffectHistory'
  );
  const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(
    (node) => node.textContent === 'e2ee.members.remove'
  ) as HTMLButtonElement;
  await act(async () => confirm.click());
  expect(remove.mock.calls).toEqual([[member.membershipId]]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('lets only the owner transfer ownership, after a confirmation that states the outcome', async () => {
  const workspace = { owner: 'self' };
  const member = {
    ordinal: 2,
    membershipId: '56'.repeat(16),
    userId: '67'.repeat(32),
    role: 'admin' as const,
    devices: [],
  };
  const management = (actorRole: 'owner' | 'admin') => ({
    actorRole,
    remove: async () => {},
    setRole: async () => {},
    transfer: async (id: string) => {
      workspace.owner = id;
    },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const openMenu = async (actorRole: 'owner' | 'admin') => {
    act(() =>
      root!.render(
        <E2eeMemberActions
          member={member}
          name="Jordan"
          management={management(actorRole)}
          onRotationSettled={() => {}}
        />
      )
    );
    const trigger = container!.querySelector('button');
    if (trigger) await act(async () => trigger.click());
  };
  await openMenu('admin');
  expect(document.querySelector('[data-testid="e2ee-member-transfer"]')).toBeNull();
  await openMenu('owner');
  await act(async () =>
    (document.querySelector('[data-testid="e2ee-member-transfer"]') as HTMLElement).click()
  );
  expect(workspace.owner).toBe('self');
  const confirmation = document.querySelector('[role="dialog"]')?.textContent ?? '';
  // The confirmation describes the transfer, not a removal.
  expect(confirmation).toContain('e2ee.members.transferLead');
  expect(confirmation).not.toContain('e2ee.members.removeLead');
  expect(confirmation).toContain('e2ee.members.transferEffectOwner');
  expect(confirmation).toContain('e2ee.members.transferEffectYou');
  await act(async () =>
    (
      document.querySelector('[data-testid="e2ee-member-transfer-confirm"]') as HTMLButtonElement
    ).click()
  );
  expect(workspace.owner).toBe(member.membershipId);
  expect(document.querySelector('[data-testid="e2ee-member-transfer-dialog"]')).toBeNull();
});
