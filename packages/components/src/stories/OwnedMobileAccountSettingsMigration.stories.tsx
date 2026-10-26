import type { Meta, StoryObj } from '@storybook/react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Provider, createStore } from 'jotai';
import { MobileAccountSettings } from '../components/mobile/mobile-account-settings';
import type { AccountSettingsPureProps } from '../components/settings/account-setting-pure';
import { SettingsStoryProviders } from './settings-story-shell';

const meta = {
  title: 'Mobile/OwnedMobileAccountSettingsMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const user = {
  id: 'synthetic-owner',
  name: 'Synthetic Account With A Long Display Name 中文边界',
  email: 'synthetic.account.with.a.long.address@example.com',
  image: null,
};
const organization = {
  id: 'synthetic-workspace',
  name: 'Synthetic Research Workspace With A Long Name 中文项目',
  slug: 'synthetic-workspace',
};
const keys: NonNullable<AccountSettingsPureProps['cliApiKeys']> = [
  {
    id: 'synthetic-key',
    name: 'Synthetic local CLI',
    keyStart: 'synthetic_1234',
    keyPreview: 'synthetic_1234…5678',
    note: 'Synthetic CLI note with a long description 中文边界',
    source: 'manual',
    createdAt: Date.parse('2026-10-01T12:00:00Z'),
    lastRequest: Date.parse('2026-10-20T09:30:00Z'),
    expiresAt: null,
    enabled: true,
  },
  {
    id: 'synthetic-auto-key',
    name: 'Synthetic automatic token',
    keyStart: 'synthetic_auto',
    keyPreview: null,
    note: null,
    source: 'auto',
    createdAt: Date.parse('2026-10-02T12:00:00Z'),
    lastRequest: null,
    expiresAt: null,
    enabled: true,
  },
];
const variables = {
  '--spacing': '0.3125rem',
  '--radius-md': '13px',
  '--muted-foreground': '285 38% 40%',
} as CSSProperties;

function RootVariables({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = Object.keys(variables).map((key) => [key, root.style.getPropertyValue(key)]);
    for (const [key, value] of Object.entries(variables)) root.style.setProperty(key, value);
    return () => {
      for (const [key, value] of previous) {
        if (value) root.style.setProperty(key, value);
        else root.style.removeProperty(key);
      }
    };
  }, []);
  return children;
}

function Fixture({
  surface = 'account',
  scope = false,
  member = false,
  loading = false,
}: {
  surface?: 'account' | 'workspace';
  scope?: boolean;
  member?: boolean;
  loading?: boolean;
}) {
  const [store] = useState(createStore);
  const [event, setEvent] = useState('Ready');
  const [pending, setPending] = useState<string | null>(null);
  const settle = useRef<{ resolve: () => void; reject: () => void } | null>(null);
  // The synthetic backend response remains controllable while a product modal makes
  // the fixture's visible controls inert. This never changes a product state directly.
  useEffect(() => {
    const complete = () => settle.current?.resolve();
    const reject = () => settle.current?.reject();
    window.addEventListener('mobile-account-complete', complete);
    window.addEventListener('mobile-account-reject', reject);
    return () => {
      window.removeEventListener('mobile-account-complete', complete);
      window.removeEventListener('mobile-account-reject', reject);
    };
  }, []);
  const [generated, setGenerated] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState(keys);
  const [members, setMembers] = useState<AccountSettingsPureProps['members']>([
    { id: 'owner-membership', userId: user.id, role: 'owner', user },
    {
      id: 'other-membership',
      userId: 'synthetic-other',
      role: 'member',
      user: {
        id: 'synthetic-other',
        name: 'Synthetic Member With A Very Long Name 中文',
        email: 'synthetic.member.with.a.long.address@example.com',
        image: null,
      },
    },
  ]);
  const pendingOperation = (label: string) => {
    setPending(label);
    setEvent(label);
    return new Promise<void>((resolve, reject) => {
      settle.current = {
        resolve: () => {
          setPending(null);
          setEvent(`Completed ${label}`);
          settle.current = null;
          resolve();
        },
        reject: () => {
          setPending(null);
          setEvent(`Rejected ${label}`);
          settle.current = null;
          reject(new Error('Synthetic operation rejected'));
        },
      };
    });
  };
  const [invitations, setInvitations] = useState<AccountSettingsPureProps['pendingInvitations']>([
    {
      id: 'synthetic-invitation',
      organizationId: organization.id,
      email: 'synthetic.pending.invitation.with.a.long.address@example.com',
      role: 'admin',
      status: 'pending',
      inviterId: user.id,
      expiresAt: new Date('2027-01-01T00:00:00Z'),
      createdAt: new Date('2026-10-01T00:00:00Z'),
    },
  ]);
  const props: AccountSettingsPureProps = {
    surface,
    currentUser: user,
    organization,
    role: member ? 'member' : 'owner',
    hasAdminPermission: !member,
    members,
    pendingInvitations: invitations,
    billingUiAvailable: false,
    seatPreview: { status: 'not_billed', reason: 'free' },
    onSignOut: () => setEvent('Sign out requested'),
    onInviteMember: async (email, role) => {
      await pendingOperation(`Invite ${email} ${role}`);
      const invitation: AccountSettingsPureProps['pendingInvitations'][number] = {
        id: 'synthetic-new-invitation',
        organizationId: organization.id,
        email,
        role,
        status: 'pending',
        inviterId: user.id,
        expiresAt: new Date('2027-01-01T00:00:00Z'),
        createdAt: new Date('2026-10-22T09:00:00Z'),
      };
      setInvitations((value) => [...value, invitation]);
      return invitation;
    },
    onRemoveMember: async (id) => {
      setMembers((value) => value.filter((entry) => entry.id !== id));
      setEvent(`Removed ${id}`);
    },
    onUpdateRole: async (entry, role) => {
      setMembers((value) => value.map((item) => (item.id === entry.id ? { ...item, role } : item)));
      setEvent(`Role ${entry.id} ${role}`);
    },
    onCopyInviteLink: async () => setEvent('Copied synthetic invite'),
    onCancelInvitation: async (id) => {
      await pendingOperation(`Cancel invitation ${id}`);
      setInvitations((value) => value.filter((invitation) => invitation.id !== id));
    },
    onLeaveOrganization: () => pendingOperation('Leave workspace'),
    onDeleteOrganization: () => pendingOperation('Delete workspace'),
    onDeleteAccount: () => pendingOperation('Delete account'),
    onRenameOrganization: (name) => pendingOperation(`Workspace name ${name}`),
    getInviteLink: () => 'https://example.com/synthetic-invite',
    onUpdateUserName: (name) => pendingOperation(`Account name ${name}`),
    showLinkedAccounts: false,
    canGenerateCliApiKey: true,
    cliApiKeys: loading ? [] : apiKeys,
    isLoadingCliApiKeys: loading,
    isCreatingCliApiKey: creating,
    hasGeneratedCliApiKey: generated,
    revokingCliApiKeyId: revoking,
    onGenerateCliApiKey: async (note) => {
      setCreating(true);
      try {
        await pendingOperation(`Create key ${note}`);
        setGenerated(true);
      } finally {
        setCreating(false);
      }
    },
    onCopyGeneratedCliApiKey: async () => setEvent('Copied synthetic generated key'),
    onClearGeneratedCliApiKey: () => setGenerated(false),
    onRevokeCliApiKey: async (id) => {
      setRevoking(id);
      try {
        await pendingOperation(`Revoke key ${id}`);
        setApiKeys((value) => value.filter((entry) => entry.id !== id));
      } finally {
        setRevoking(null);
      }
    },
  };
  return (
    <Provider store={store}>
      <SettingsStoryProviders>
        <div
          data-mobile-account-fixture
          data-surface={surface}
          style={{
            minHeight: '100vh',
            maxWidth: 640,
            margin: '0 auto',
            padding: '16px 0',
            background: 'hsl(var(--background))',
            ...(scope ? variables : {}),
          }}
        >
          <MobileAccountSettings {...props} />
          <aside style={{ padding: 12 }}>
            <output data-mobile-account-result>{event}</output>
            {pending ? (
              <div data-mobile-account-pending={pending}>
                <button
                  type="button"
                  data-complete-operation
                  onClick={() => settle.current?.resolve()}
                >
                  Complete synthetic operation
                </button>
                <button
                  type="button"
                  data-reject-operation
                  onClick={() => settle.current?.reject()}
                >
                  Reject synthetic operation
                </button>
              </div>
            ) : null}
          </aside>
        </div>
      </SettingsStoryProviders>
    </Provider>
  );
}

export const Account: Story = { render: () => <Fixture /> };
export const AccountSubtreeVariables: Story = { render: () => <Fixture scope /> };
export const AccountRootVariables: Story = {
  render: () => (
    <RootVariables>
      <Fixture />
    </RootVariables>
  ),
};
export const LoadingKeys: Story = { render: () => <Fixture loading /> };
export const Workspace: Story = { render: () => <Fixture surface="workspace" /> };
export const WorkspaceSubtreeVariables: Story = {
  render: () => <Fixture surface="workspace" scope />,
};
export const WorkspaceMember: Story = { render: () => <Fixture surface="workspace" member /> };
