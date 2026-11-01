// @vitest-environment jsdom
import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Result } from 'effect';
import { exportVerifiedState } from '@lody/e2ee-core/protocol';
import { appendLedgerHistory, bytesToHex } from '../src/lib/e2ee-ledger-history';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { E2eeMemberOffer, E2eeMemberReplies } from '@lody/cloud-api';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { E2eeMemberJoin } from '../src/components/pages/e2ee-member-join';
import {
  E2eeTeamSettings,
  E2eeTeamSettingsHost,
} from '../src/components/settings/e2ee-team-settings';
import {
  E2eeTeamInboxHost,
  startEmailAdmissionWorker,
} from '../src/components/e2ee/email-admission-worker';
import {
  desktopMemberJoinLink,
  memberJoinPath,
  parseMemberOffer,
} from '../src/lib/e2ee-member-offer';
import { resolveDesktopInviteDeepLinkPath } from '../src/lib/desktop-invite-deep-link';
vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('../src/components/settings/invite-member-dialog', () => ({
  SeatCostNotice: ({ preview }: { preview: unknown }) => (
    <p>{preview ? 'seat quote' : 'quote loading'}</p>
  ),
}));
const offer: E2eeMemberOffer = {
  version: 1,
  workspaceId: 'team',
  genesisHash: '11'.repeat(32),
  genesisRecordHex: 'abcd',
  endorser: '22'.repeat(32),
  token: '33'.repeat(32),
  mode: 'link',
  expiresAt: 2000,
};
const application = (
  id: string,
  source: 'email' | 'link'
): E2eeMemberReplies['pending']['items'][number] => ({
  id,
  workspaceId: 'team',
  accountId: id,
  keyPackageHex: 'abcd',
  signingPublicKey: '44'.repeat(32),
  requestId: id,
  source,
  state: 'pending',
  expiresAt: 2000,
  applicantName: id,
  applicantEmail: `${id}@synthetic.test`,
});
const empty: E2eeMemberReplies['pending'] = {
  items: [],
  invitations: [],
  hasMore: false,
  seatPreview: { status: 'not_billed', reason: 'free' },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });
const status = { deviceKind: 'personal', memberRole: 'admin' } as Awaited<
  ReturnType<E2eeWorkspaceRuntime['status']>
>;
describe('encrypted team joining', () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  const render = async (node: React.ReactNode) => {
    await act(async () => root.render(node));
  };
  const button = (key: string) =>
    [...container.querySelectorAll('button')].find((item) => item.textContent === key)!;
  it('automatically admits only accepted emails, isolates one failure and stops late work', async () => {
    const states = new Map([
      ['bad', 'pending'],
      ['email', 'pending'],
      ['link', 'pending'],
    ]);
    const stop = startEmailAdmissionWorker(
      {
        status: async () => status,
        memberJoinRequests: async () => ({
          ...empty,
          items: [
            application('bad', 'email'),
            application('email', 'email'),
            application('link', 'link'),
          ],
        }),
        approveMemberJoin: async (_workspace, id, mode) => {
          expect(mode).toBe('automatic');
          if (id === 'bad') throw new Error('offline');
          states.set(id, 'committed');
          return { admitted: true, keyPending: true };
        },
      },
      'team'
    );
    await settle();
    expect([...states]).toEqual([
      ['bad', 'pending'],
      ['email', 'committed'],
      ['link', 'pending'],
    ]);
    stop();
    const pending = deferred<E2eeMemberReplies['pending']>();
    const stopLate = startEmailAdmissionWorker(
      {
        status: async () => status,
        memberJoinRequests: () => pending.promise,
        approveMemberJoin: async (_workspace, id) => {
          states.set(id, 'committed');
          return { admitted: true, keyPending: true };
        },
      },
      'team'
    );
    await settle();
    stopLate();
    pending.resolve({ ...empty, items: [application('link', 'email')] });
    await settle();
    expect(states.get('link')).toBe('pending');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('recovers the saved original after expiry and separates membership from key readiness', async () => {
    let installed = false;
    const runtime = {
      pendingMemberJoin: async () => ({ offer, requestId: 'original' }),
      prepareMemberJoin: async () => {
        throw new Error('must not replace saved request');
      },
      claimMemberJoin: async () => ({ state: 'committed', ready: installed }),
    };
    vi.setSystemTime(3000);
    const props = {
      offer,
      runtime,
      accountId: 'account',
      email: 'a@synthetic.test',
      emailVerified: true,
      preview: { status: 'unavailable' as const },
      onSignInRequested: () => {},
      onEmailVerificationRequested: () => {},
      onWorkspaceRequested: () => {},
      onHomeRequested: () => {},
    };
    await render(<E2eeMemberJoin {...props} />);
    await settle();
    expect(container.textContent).toContain('e2ee.team.waitingKey');
    expect(button('e2ee.team.submit')).toBeUndefined();
    installed = true;
    await act(async () => window.dispatchEvent(new Event('online')));
    await settle();
    expect(container.textContent).toContain('e2ee.team.ready');
    expect(button('e2ee.team.openWorkspace')).toBeDefined();
  });
  it('shows saved request progress after a lost submit response without another consent request', async () => {
    let saved = false;
    const runtime = {
      pendingMemberJoin: async () => (saved ? { offer, requestId: 'original' } : null),
      prepareMemberJoin: async () => {
        saved = true;
        throw new Error('lost acknowledgement');
      },
      claimMemberJoin: async () => ({ state: 'pending', ready: false }),
    };
    await render(
      <E2eeMemberJoin
        offer={offer}
        runtime={runtime}
        accountId="account"
        emailVerified
        preview={{
          status: 'available',
          offer,
          workspaceName: 'Team',
          workspaceSlug: 'team',
          recipientEmailMasked: null,
          matchesRecipient: null,
        }}
        onSignInRequested={() => {}}
        onEmailVerificationRequested={() => {}}
        onWorkspaceRequested={() => {}}
        onHomeRequested={() => {}}
      />
    );
    await act(async () => button('e2ee.team.submit').click());
    await settle();
    expect(saved).toBe(true);
    expect(container.textContent).toContain('e2ee.team.waitingApproval');
    expect(button('e2ee.team.submit')).toBeUndefined();
  });
  it('keeps a link request pending until the administrator approves the displayed request', async () => {
    const request = application('applicant', 'link');
    let state = 'pending';
    const confirmation = deferred<{ admitted: boolean; keyPending: boolean }>();
    await render(
      <E2eeTeamSettings
        workspaceId="team"
        runtime={{
          createMemberInvitation: async () => offer,
          memberJoinRequests: async () => ({
            ...empty,
            items: state === 'pending' ? [request] : [],
          }),
          approveMemberJoin: async (_workspace, id, mode) => {
            expect(id).toBe(request.requestId);
            expect(mode).toBe('explicit');
            const result = await confirmation.promise;
            state = 'committed';
            return result;
          },
          rejectMemberJoin: async () => ({ state: 'rejected' }),
          revokeMemberInvitation: async () => ({ revoked: true }),
        }}
      />
    );
    expect(container.textContent).toContain('seat quote');
    expect(state).toBe('pending');
    await act(async () => button('e2ee.team.approve').click());
    expect(state).toBe('pending');
    expect(button('e2ee.team.approve').disabled).toBe(true);
    confirmation.resolve({ admitted: true, keyPending: true });
    await settle();
    expect(state).toBe('committed');
    expect(container.textContent).toContain('e2ee.team.admitted');
    expect(container.textContent).toContain('e2ee.team.noRequests');
  });
  it('recovers online manager qualification after an initial failed refresh and releases each owned background reader', async () => {
    let role = 'member',
      attempts = 0,
      readers = 0,
      admitted = false;
    const runtime = {
      open: async (_workspace: string, _observed: unknown, account: string) => {
        expect(account).toBe('account');
        readers++;
        return { ...status, readerOwner: 'original' };
      },
      close: async (_workspace: string, account: string, owner: string) => {
        expect(account).toBe('account');
        expect(owner).toBe('original');
        readers--;
      },
      refresh: async () => {
        if (++attempts === 1) throw new Error('offline');
        role = 'admin';
        return status;
      },
      status: async () => ({ ...status, memberRole: role }),
      memberJoinRequests: async () => ({ ...empty, items: [application('email', 'email')] }),
      approveMemberJoin: async () => {
        admitted = true;
        return { admitted: true, keyPending: true };
      },
    } as unknown as E2eeWorkspaceRuntime;
    await render(<E2eeTeamInboxHost runtime={runtime} workspaceId="team" accountId="account" />);
    await settle();
    expect(admitted).toBe(false);
    expect(readers).toBe(0);
    await act(async () => window.dispatchEvent(new Event('online')));
    await settle();
    expect(admitted).toBe(true);
    expect(readers).toBe(0);
  });
  it('uses the shared member-role command and reports success only after it completes', async () => {
    let role: 'member' | 'admin' = 'member';
    const accepted = deferred<void>();
    await render(
      <E2eeTeamSettings
        workspaceId="team"
        canPromote
        members={[{ membershipId: '55'.repeat(16), role, name: 'Riley' }]}
        runtime={{
          createMemberInvitation: async () => offer,
          memberJoinRequests: async () => empty,
          approveMemberJoin: async () => ({ admitted: true, keyPending: false }),
          rejectMemberJoin: async () => ({ state: 'rejected' }),
          revokeMemberInvitation: async () => ({ revoked: true }),
          setMemberRole: async (workspaceId, membershipId, nextRole) => {
            expect([workspaceId, membershipId, nextRole]).toEqual([
              'team',
              '55'.repeat(16),
              'admin',
            ]);
            await accepted.promise;
            role = nextRole;
          },
        }}
      />
    );
    await act(async () => button('e2ee.team.promote').click());
    expect(role).toBe('member');
    expect(button('e2ee.team.promote').disabled).toBe(true);
    expect(container.textContent).not.toContain('e2ee.team.promoted');
    accepted.resolve();
    await settle();
    expect(role).toBe('admin');
    expect(container.textContent).toContain('e2ee.team.promoted');
  });
  it.each([
    ['personal', 'owner', true, true],
    ['personal', 'admin', true, true],
    ['personal', 'member', true, false],
    ['personal', 'guest', true, false],
    ['recovery', 'owner', true, false],
    ['machine', 'owner', true, false],
    ['personal', 'owner', false, false],
  ] as const)(
    'uses verified personal management facts without a local agent: %s / %s / credential %s',
    async (deviceKind, memberRole, hasDeviceCredential, allowed) => {
      const vector = JSON.parse(
        readFileSync(
          join(import.meta.dirname, '../../e2ee-core/test/ledger-v1-vector.json'),
          'utf8'
        )
      ) as { anchor: string; records: { hex: string; hash: string }[] };
      const history = appendLedgerHistory(
        null,
        {
          workspaceId: 'team',
          genesisHash: vector.anchor,
          checkpoint: { length: 1, headHash: vector.anchor },
          startIndex: 0,
          nextCursor: null,
          recordsHex: [vector.records[0]!.hex],
        },
        { workspaceId: 'team', genesisHash: vector.anchor, localPin: vector.anchor }
      );
      const snapshot = Result.getOrThrow(exportVerifiedState(history.view));
      const ledger = {
        stateHex: bytesToHex(snapshot.bytes),
        recordsHex: [vector.records[0]!.hex],
        status: {
          workspaceId: 'team',
          genesisHash: vector.anchor,
          length: 1,
          headHash: vector.anchor,
          stateDigest: bytesToHex(snapshot.stateDigest.toBytes()),
          epoch: 0,
          rotationRequired: false,
          deviceKind,
          memberRole,
          hasDeviceCredential,
          hasCurrentKey: true,
          continuityPending: false,
        },
      };
      const invitations: unknown[] = [];
      const runtime = {
        ledgerView: async () => ledger,
        createMemberInvitation: async (input: unknown) => {
          invitations.push(input);
          return offer;
        },
        memberJoinRequests: async () => empty,
        approveMemberJoin: async () => ({ admitted: true, keyPending: false }),
        rejectMemberJoin: async () => ({ state: 'rejected' }),
        revokeMemberInvitation: async () => ({ revoked: true }),
      } as unknown as E2eeWorkspaceRuntime;
      await render(
        <E2eeTeamSettingsHost runtime={runtime} workspaceId="team" accountId="account" />
      );
      const create = () =>
        [...container.querySelectorAll('button')].find(
          (node) => node.textContent === 'e2ee.team.createLink'
        );
      if (!allowed) {
        expect(create()).toBeUndefined();
        expect(invitations).toEqual([]);
        return;
      }
      expect(create()).toBeDefined();
      await act(async () => create()!.click());
      expect(invitations).toEqual([{ workspaceId: 'team', mode: 'link' }]);
      expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toContain(
        offer.token
      );
      const pending = deferred<typeof ledger>();
      await render(
        <E2eeTeamSettingsHost
          runtime={{ ...runtime, ledgerView: () => pending.promise }}
          workspaceId="team"
          accountId="account"
        />
      );
      expect(create()).toBeUndefined();
      pending.resolve({
        ...ledger,
        status: { ...ledger.status, memberRole: 'guest' },
      } as typeof ledger);
      await settle();
      expect(create()).toBeUndefined();
    }
  );
  it('preserves independent genesis pins through desktop handoff and rejects a different token', () => {
    const path = resolveDesktopInviteDeepLinkPath(desktopMemberJoinLink(offer));
    expect(path).toBe(memberJoinPath(offer));
    const data = new URLSearchParams(path!.slice(path!.indexOf('#') + 1)).get('e2ee')!;
    expect(parseMemberOffer(data, offer.token)).toEqual(offer);
    expect(parseMemberOffer(data, '99'.repeat(32))).toBeNull();
  });
});
