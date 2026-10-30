import { E2eeMemberActions } from '../src/components/pages/e2ee-member-actions';
// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2eeWorkspaceControlPage } from '../src/components/pages/e2ee-workspace-control-page';
import { appendLedgerHistory } from '../src/lib/e2ee-ledger-history';
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
  it('always marks the workspace as an encrypted developer preview', () => {
    render({});
    expect(container!.textContent).toContain('e2ee.control.badge');
  });

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
  // The final record declares an unsupported capability after independent removal.
  const full = appendLedgerHistory(
    null,
    page(vector.records.length, vector.records.at(-1)!.hash),
    expected(vector.anchor)
  );
  const history = (localPin: string | null) =>
    appendLedgerHistory(null, page(11, full.records[10]!.hash), expected(localPin));

  it('summarizes who did what and lists current members', () => {
    render({ history: history(vector.anchor) });
    const text = container!.textContent!;
    expect(text).toContain('e2ee.summary.transferOwner');
    const members = [
      ...container!.querySelectorAll('section[aria-label="e2ee.control.members"] li'),
    ];
    expect(members.map((row) => row.textContent)).toEqual([
      expect.stringContaining('"number":3'),
      expect.stringContaining('"number":1'),
    ]);
    expect(members[0]!.textContent).toContain('e2ee.values.owner');
  });

  it('shows the verification code for the verified state', () => {
    render({ history: history(vector.anchor) });
    const code = container!.querySelector('[aria-label="e2ee.verify.codeLabel"]')!.textContent;
    expect(code).toBe(ledgerVerificationCode(history(vector.anchor)).stateDigest);
    expect(container!.querySelector('svg[aria-label="e2ee.verify.qrLabel"] path')).not.toBeNull();
  });

  it('names the genesis member after this account only when this device holds the pin', () => {
    const you = { name: 'Alex Chen' };
    const profiles = new Map([['03'.repeat(32), { name: 'Jordan Lee' }]]);
    render({ history: history(vector.anchor), you });
    let text = container!.textContent!;
    expect(text).toContain('Alex Chen');
    expect(text).toContain('e2ee.control.you');
    expect(text).toContain('"actor":"Alex Chen"');
    act(() => root?.unmount());
    render({ history: history(null), you, memberProfiles: profiles });
    text = container!.textContent!;
    expect(text).not.toContain('Alex Chen');
    expect(text).toContain('Jordan Lee');
  });

  it('maps profiles through verified crypto users without changing roles, members or verification', () => {
    const verified = history(vector.anchor);
    const before = ledgerVerificationCode(verified).stateDigest;
    const forged = { name: 'Display owner', role: 'guest', signingPublicKey: 'forged' };
    const profiles = new Map([
      ['03'.repeat(32), forged],
      ['ff'.repeat(32), { name: 'Not a ledger member' }],
    ]);
    render({ history: verified, memberProfiles: profiles, you: { name: 'Wrong creator' } });
    const members = container!.querySelector('section[aria-label="e2ee.control.members"]')!;
    expect(members.querySelectorAll('li')).toHaveLength(2);
    expect(members.textContent).toContain('Display owner');
    expect(members.querySelector('li')!.textContent).toContain('e2ee.values.owner');
    expect(container!.textContent).not.toContain('Not a ledger member');
    expect(container!.textContent).not.toContain('Wrong creator');
    expect(container!.querySelector('[aria-label="e2ee.verify.codeLabel"]')!.textContent).toBe(
      before
    );
    expect(ledgerVerificationCode(verified).stateDigest).toBe(before);
  });

  it('shows no verdict about the genesis pin, only the ledger', () => {
    render({ history: history(null) });
    const text = container!.textContent!;
    expect(text).not.toMatch(/status\.|verifiedPinned|verifiedUnpinned/);
    expect(container!.querySelector('[aria-label="e2ee.verify.codeLabel"]')).not.toBeNull();
  });

  it('keeps the explanation behind the help button', () => {
    render({ history: history(vector.anchor) });
    expect(container!.textContent).not.toContain('e2ee.verify.hint');
    act(() =>
      container!.querySelector<HTMLButtonElement>('button[aria-label="e2ee.control.help"]')!.click()
    );
    expect(container!.textContent).toContain('e2ee.verify.hint');
  });

  it('reads independent removal while preserving the published epoch', () => {
    const count = vector.records.length - 1;
    const verified = appendLedgerHistory(
      null,
      page(count, vector.records[count - 1]!.hash),
      expected(vector.anchor)
    );
    render({ history: verified });
    expect(container!.textContent).toContain('e2ee.summary.removeMember');
    expect(
      container!.querySelectorAll('section[aria-label="e2ee.control.members"] li')
    ).toHaveLength(1);
    expect(verified.view.inspectState().epoch).toMatchObject({ number: 2, rotationRequired: true });
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
  await act(async () => action('e2ee.members.remove').click());
  expect(remove).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'e2ee.members.removeDescription'
  );
  const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(
    (node) => node.textContent === 'e2ee.members.remove'
  ) as HTMLButtonElement;
  await act(async () => confirm.click());
  expect(remove.mock.calls).toEqual([[member.membershipId]]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
