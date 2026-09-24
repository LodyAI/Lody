import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import type { Invitation } from 'better-auth/plugins';
import type { AvatarKind, CliApiKeyRecord } from '@lody/shared';
import {
  UserPlus,
  Mail,
  Clock,
  Copy,
  Trash2,
  ChevronDown,
  Check,
  LogOut,
  KeyRound,
  Pencil,
  X,
} from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Field as UiField } from '@lody/ui/field';
import { Badge } from '@lody/ui/badge';
import { Avatar } from '@lody/ui/avatar';
import { Alert } from '@lody/ui/alert';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { Menu } from '@/ui/menu';
import { UserAvatar } from '../user-avatar';
import type { OrganizationMemberRef, OrganizationMemberRole } from '@/lib/organization-member-role';
import { Dialog } from '@/ui/dialog';
import { AlertDialog } from '@/ui/dialog';
import { CompactRow, CompactSection } from './compact-layout';
import {
  InviteMemberDialog,
  type InviteMemberRole,
  type SeatInvitePreview,
} from './invite-member-dialog';
import { AvatarEditor } from './avatar-editor';
import { ChangePasswordButton } from './change-password-button';
import { LinkedAccountsList, type LinkedAccountInfo } from './linked-accounts-list';
import { MobileAccountSettings } from '@/components/mobile/mobile-account-settings';
import { useIsMobile } from '@/hooks/use-mobile';
import { settingsSurface } from './surface';

const WIDE = '@media (min-width: 640px)';

const styles = stylex.create({
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    paddingBlock: space[8],
  },
  /** An editable value is a ghost button holding it; it may shrink to the row. */
  valueButton: { maxWidth: '100%', minWidth: 0 },
  value: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 400,
    color: colors.label,
  },
  valueText: {
    display: 'block',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.label,
  },
  valueIcon: { width: '12px', height: '12px', flexShrink: 0, color: colors.tertiaryLabel },
  icon: { width: '14px', height: '14px', flexShrink: 0 },
  /** An icon-only button draws the glyph's box; the glyph fills it. */
  glyph: { width: '100%', height: '100%' },

  /** A record in a list card: its face, what it is, and what can be done to it. */
  record: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    paddingInline: space[4],
    paddingBlock: '10px',
  },
  recordText: { flexGrow: 1, minWidth: 0 },
  recordTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    margin: 0,
    lineHeight: 1.25,
    color: colors.label,
  },
  recordMeta: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    margin: 0,
    marginTop: '2px',
    fontSize: '0.8em',
    lineHeight: 1.25,
    color: colors.secondaryLabel,
  },
  you: { marginInlineStart: space[1.5], fontSize: '0.75em', color: colors.secondaryLabel },
  recordActions: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: space[1] },
  inviteMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    marginTop: '2px',
    fontSize: '0.75em',
    color: colors.secondaryLabel,
  },
  inviteStatus: { display: 'inline-flex', alignItems: 'center', gap: '2px' },
  clock: { width: '10px', height: '10px', flexShrink: 0 },

  noteLoading: { display: 'flex', alignItems: 'center', gap: space[2] },
  apiKey: {
    display: 'flex',
    flexDirection: { default: 'column', [WIDE]: 'row' },
    alignItems: { default: 'stretch', [WIDE]: 'center' },
    justifyContent: 'space-between',
    gap: space[3],
    paddingInline: space[4],
    paddingBlock: '10px',
  },
  apiKeyText: { display: 'flex', flexDirection: 'column', gap: space[1], minWidth: 0 },
  apiKeyHead: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: space[2],
    rowGap: space[1],
    minWidth: 0,
  },
  apiKeyNote: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    margin: 0,
    color: colors.label,
  },
  apiKeyTime: { flexShrink: 0, fontSize: '0.8em', color: colors.secondaryLabel },
  apiKeyMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: space[3],
    rowGap: space[1],
    fontSize: '0.8em',
    color: colors.secondaryLabel,
  },
  mono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
  alignStart: { alignSelf: { default: 'flex-start', [WIDE]: 'center' } },

  /** A dialog's body between its header and its answers. */
  dialogBody: { display: 'flex', flexDirection: 'column', gap: space[3] },
  dialogForm: { display: 'flex', flexDirection: 'column', gap: space[4] },
  field: { display: 'flex', flexDirection: 'column', gap: space[1.5] },
  prose: { margin: 0, fontSize: '13px', lineHeight: 1.5, color: colors.secondaryLabel },
  alignSelfStart: { alignSelf: 'flex-start' },
});

function formatCliApiKeyTimestamp(
  value: number | null
): { label: string; dateTime: string } | null {
  if (value === null) {
    return null;
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  return {
    label: new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date),
    dateTime: date.toISOString(),
  };
}

export interface AccountMember {
  id: string;
  userId: string;
  role: string;
  user?: {
    id?: string | null;
    name?: string | null;
    image?: string | null;
    email?: string | null;
  } | null;
}

/**
 * Billing state gating workspace deletion:
 * - `active-subscription`: block deletion and point the owner at billing
 *   settings to cancel first.
 * - `cancel-scheduled`: deletion is allowed, but warn that the subscription
 *   (still paid until `formattedPeriodEnd`) ends immediately on delete.
 */
export type WorkspaceDeleteBillingGuard =
  | { kind: 'active-subscription' }
  | { kind: 'cancel-scheduled'; formattedPeriodEnd: string | null };

export type AccountSettingsSurface = 'account' | 'workspace';

export interface AccountSettingsPureProps {
  surface?: AccountSettingsSurface;
  currentUser?: {
    id?: string | null;
    name?: string | null;
    image?: string | null;
    email?: string | null;
  } | null;
  organization: {
    id: string;
    name: string;
    slug?: string | null;
    logo?: string | null;
  };
  role: 'owner' | 'admin' | 'member';
  hasAdminPermission: boolean;
  members: AccountMember[];
  pendingInvitations: Invitation[];
  workspaceJoinRequestsSlot?: ReactNode;
  workspaceOwnershipSlot?: ReactNode;
  /** Account-only machine overview supplied by the runtime-aware container. */
  accountMachinesSlot?: ReactNode;
  memberLimit?: number | null;
  memberLimitReached?: boolean;
  billingUiAvailable?: boolean;
  /**
   * Seat cost of one more member, shown in the invite dialog. `undefined`
   * while loading; `null` when unavailable.
   */
  seatPreview?: SeatInvitePreview | null;
  loading?: boolean;
  onSignOut: () => void | Promise<void>;
  onInviteMember: (email: string, role: 'member' | 'admin') => Promise<Invitation | null>;
  onRemoveMember: (memberId: string) => Promise<void>;
  onUpdateRole: (member: OrganizationMemberRef, newRole: OrganizationMemberRole) => Promise<void>;
  onCopyInviteLink: (link: string) => Promise<void>;
  onCancelInvitation: (invitationId: string) => Promise<void>;
  onLeaveOrganization: () => Promise<void>;
  onDeleteOrganization: () => Promise<void>;
  /** Billing state gating workspace deletion (see WorkspaceDeleteBillingGuard). */
  deleteBillingGuard?: WorkspaceDeleteBillingGuard | null;
  onDeleteAccount: () => Promise<void>;
  onRenameOrganization?: (name: string) => Promise<void>;
  onOpenBilling?: () => void;
  getInviteLink: (invitation: Invitation) => string;
  // Profile: user name + user/workspace avatar + OAuth bindings + password.
  onUpdateUserName?: (name: string) => Promise<void>;
  onUploadAvatar?: (args: { kind: AvatarKind; file: File }) => Promise<string>;
  linkedAccounts?: LinkedAccountInfo[];
  isLoadingLinkedAccounts?: boolean;
  onConnectAccount?: (providerId: string) => Promise<void> | void;
  /** Whether to show the connected-accounts (OAuth binding) row. Hidden on
   * Electron/native where linking isn't supported. */
  showLinkedAccounts?: boolean;
  hasPasswordCredential?: boolean;
  onChangePassword?: (args: { currentPassword: string; newPassword: string }) => Promise<void>;
  onVerifyCurrentPassword?: (password: string) => Promise<boolean>;
  onSetupPassword?: () => Promise<void>;
  canGenerateCliApiKey?: boolean;
  cliApiKeys?: CliApiKeyRecord[];
  isLoadingCliApiKeys?: boolean;
  isCreatingCliApiKey?: boolean;
  hasGeneratedCliApiKey?: boolean;
  revokingCliApiKeyId?: string | null;
  onGenerateCliApiKey?: (note: string) => Promise<void> | void;
  onCopyGeneratedCliApiKey?: () => Promise<void> | void;
  onClearGeneratedCliApiKey?: () => void;
  onRevokeCliApiKey?: (keyId: string) => Promise<void> | void;
}

export function AccountSettingsPure({
  surface = 'account',
  currentUser,
  organization,
  role,
  hasAdminPermission,
  members,
  pendingInvitations: initialPendingInvitations,
  workspaceJoinRequestsSlot,
  workspaceOwnershipSlot,
  accountMachinesSlot,
  memberLimit = null,
  memberLimitReached = false,
  billingUiAvailable = true,
  seatPreview,
  loading,
  onSignOut,
  onInviteMember,
  onRemoveMember,
  onUpdateRole,
  onCopyInviteLink,
  onCancelInvitation,
  onLeaveOrganization,
  onDeleteOrganization,
  deleteBillingGuard = null,
  onDeleteAccount,
  onRenameOrganization,
  onOpenBilling,
  getInviteLink,
  onUpdateUserName,
  onUploadAvatar,
  linkedAccounts = [],
  isLoadingLinkedAccounts = false,
  onConnectAccount,
  showLinkedAccounts = true,
  hasPasswordCredential = false,
  onChangePassword,
  onVerifyCurrentPassword,
  onSetupPassword,
  canGenerateCliApiKey = false,
  cliApiKeys = [],
  isLoadingCliApiKeys = false,
  isCreatingCliApiKey = false,
  hasGeneratedCliApiKey = false,
  revokingCliApiKeyId = null,
  onGenerateCliApiKey,
  onCopyGeneratedCliApiKey,
  onClearGeneratedCliApiKey,
  onRevokeCliApiKey,
}: AccountSettingsPureProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const isWorkspaceSurface = surface === 'workspace';
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [deleteUserDialogOpen, setDeleteUserDialogOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [pendingInvitations, setPendingInvitations] = useState(initialPendingInvitations);
  const [cancellingInvitationIds, setCancellingInvitationIds] = useState<Set<string>>(
    () => new Set()
  );
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteBlockedDialogOpen, setDeleteBlockedDialogOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteAccountDialogOpen, setDeleteAccountDialogOpen] = useState(false);
  const [deleteAccountConfirmText, setDeleteAccountConfirmText] = useState('');
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState(organization.name);
  const [workspaceNameBaseline, setWorkspaceNameBaseline] = useState(organization.name);
  const [isEditingWorkspaceName, setIsEditingWorkspaceName] = useState(false);
  const [isRenamingOrganization, setIsRenamingOrganization] = useState(false);
  const [cliApiKeyDialogOpen, setCliApiKeyDialogOpen] = useState(false);
  const [cliApiKeyNote, setCliApiKeyNote] = useState('');
  const [cliApiKeyToRevoke, setCliApiKeyToRevoke] = useState<CliApiKeyRecord | null>(null);
  const workspaceNameInputRef = useRef<HTMLInputElement>(null);

  // Profile: user display-name inline edit (mirrors the workspace name pattern).
  const [userNameDraft, setUserNameDraft] = useState(currentUser?.name ?? '');
  const [userNameBaseline, setUserNameBaseline] = useState(currentUser?.name ?? '');
  const [isEditingUserName, setIsEditingUserName] = useState(false);
  const [isSavingUserName, setIsSavingUserName] = useState(false);
  const userNameInputRef = useRef<HTMLInputElement>(null);

  // Optimistic avatar state; the parent persists to R2 + BetterAuth and we
  // mirror the returned URL locally so the new image paints immediately.
  const [userImage, setUserImage] = useState<string | null | undefined>(currentUser?.image ?? null);
  const [workspaceLogo, setWorkspaceLogo] = useState<string | null | undefined>(
    organization.logo ?? null
  );

  useEffect(() => {
    setPendingInvitations(initialPendingInvitations);
  }, [initialPendingInvitations]);

  useEffect(() => {
    setUserNameDraft(currentUser?.name ?? '');
    setUserNameBaseline(currentUser?.name ?? '');
  }, [currentUser?.name]);

  useEffect(() => {
    setUserImage(currentUser?.image ?? null);
  }, [currentUser?.image]);

  useEffect(() => {
    setWorkspaceLogo(organization.logo ?? null);
  }, [organization.logo]);

  useEffect(() => {
    if (!isEditingUserName) return;
    userNameInputRef.current?.focus();
    userNameInputRef.current?.select();
  }, [isEditingUserName]);

  useEffect(() => {
    setWorkspaceNameDraft(organization.name);
    setWorkspaceNameBaseline(organization.name);
  }, [organization.name]);

  useEffect(() => {
    if (!isEditingWorkspaceName) return;
    workspaceNameInputRef.current?.focus();
    workspaceNameInputRef.current?.select();
  }, [isEditingWorkspaceName]);

  const trimmedWorkspaceName = workspaceNameDraft.trim();
  const canRenameOrganization = hasAdminPermission && Boolean(onRenameOrganization);
  const workspaceNameChanged = trimmedWorkspaceName !== workspaceNameBaseline;
  const workspaceNameInvalid = trimmedWorkspaceName.length === 0;

  const beginWorkspaceNameEdit = () => {
    if (!canRenameOrganization || isRenamingOrganization) {
      return;
    }
    setWorkspaceNameDraft(workspaceNameBaseline);
    setIsEditingWorkspaceName(true);
  };

  const cancelWorkspaceNameEdit = () => {
    setWorkspaceNameDraft(workspaceNameBaseline);
    setIsEditingWorkspaceName(false);
  };

  const commitWorkspaceNameEdit = async () => {
    if (!canRenameOrganization || isRenamingOrganization) {
      return;
    }
    if (workspaceNameInvalid || !workspaceNameChanged) {
      cancelWorkspaceNameEdit();
      return;
    }

    const previousName = workspaceNameBaseline;
    const nextName = trimmedWorkspaceName;
    setIsEditingWorkspaceName(false);
    setWorkspaceNameDraft(nextName);
    setWorkspaceNameBaseline(nextName);
    setIsRenamingOrganization(true);
    try {
      await onRenameOrganization?.(nextName);
    } catch {
      // The container owns the error toast; revert the optimistic label on failure.
      setWorkspaceNameDraft(previousName);
      setWorkspaceNameBaseline(previousName);
    } finally {
      setIsRenamingOrganization(false);
    }
  };

  const handleWorkspaceNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelWorkspaceNameEdit();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    }
  };

  const trimmedUserName = userNameDraft.trim();
  const canEditUserName = Boolean(onUpdateUserName);
  const userNameChanged = trimmedUserName !== userNameBaseline;
  const userNameInvalid = trimmedUserName.length === 0;

  const beginUserNameEdit = () => {
    if (!canEditUserName || isSavingUserName) return;
    setUserNameDraft(userNameBaseline);
    setIsEditingUserName(true);
  };

  const cancelUserNameEdit = () => {
    setUserNameDraft(userNameBaseline);
    setIsEditingUserName(false);
  };

  const commitUserNameEdit = async () => {
    if (!canEditUserName || isSavingUserName) return;
    if (userNameInvalid || !userNameChanged) {
      cancelUserNameEdit();
      return;
    }

    const previousName = userNameBaseline;
    const nextName = trimmedUserName;
    setIsEditingUserName(false);
    setUserNameDraft(nextName);
    setUserNameBaseline(nextName);
    setIsSavingUserName(true);
    try {
      await onUpdateUserName?.(nextName);
    } catch {
      // The container owns the error toast; revert the optimistic label.
      setUserNameDraft(previousName);
      setUserNameBaseline(previousName);
    } finally {
      setIsSavingUserName(false);
    }
  };

  const handleUserNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelUserNameEdit();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    }
  };

  const handleUploadAvatar = async (kind: AvatarKind, file: File) => {
    if (!onUploadAvatar) return;
    const url = await onUploadAvatar({ kind, file });
    if (kind === 'user') {
      setUserImage(url);
    } else {
      setWorkspaceLogo(url);
    }
  };

  const handleInviteMember = async (email: string, invitedRole: InviteMemberRole) => {
    setInviting(true);
    try {
      const result = await onInviteMember(email, invitedRole);
      if (result) {
        setPendingInvitations((prev) => [...prev, result]);
        setInviteDialogOpen(false);
      }
    } finally {
      setInviting(false);
    }
  };

  const handleRemoveMember = async () => {
    if (!userToDelete) return;
    try {
      await onRemoveMember(userToDelete);
    } finally {
      setDeleteUserDialogOpen(false);
      setUserToDelete(null);
    }
  };

  const handleCliApiKeyDialogOpenChange = (open: boolean) => {
    setCliApiKeyDialogOpen(open);
    if (!open) {
      setCliApiKeyNote('');
      onClearGeneratedCliApiKey?.();
    }
  };

  const handleCreateCliApiKey = async () => {
    await onGenerateCliApiKey?.(cliApiKeyNote);
  };

  if (loading) {
    return (
      <div {...stylex.props(styles.loading)}>
        <Spinner size="large" />
      </div>
    );
  }

  if (isMobile) {
    return (
      <MobileAccountSettings
        surface={surface}
        currentUser={currentUser}
        organization={organization}
        role={role}
        hasAdminPermission={hasAdminPermission}
        members={members}
        pendingInvitations={initialPendingInvitations}
        workspaceJoinRequestsSlot={workspaceJoinRequestsSlot}
        workspaceOwnershipSlot={workspaceOwnershipSlot}
        memberLimit={memberLimit}
        memberLimitReached={memberLimitReached}
        billingUiAvailable={billingUiAvailable}
        seatPreview={seatPreview}
        onSignOut={onSignOut}
        onInviteMember={onInviteMember}
        onRemoveMember={onRemoveMember}
        onUpdateRole={onUpdateRole}
        onCopyInviteLink={onCopyInviteLink}
        onCancelInvitation={onCancelInvitation}
        onLeaveOrganization={onLeaveOrganization}
        onDeleteOrganization={onDeleteOrganization}
        deleteBillingGuard={deleteBillingGuard}
        onDeleteAccount={onDeleteAccount}
        onRenameOrganization={onRenameOrganization}
        getInviteLink={getInviteLink}
        onUpdateUserName={onUpdateUserName}
        onUploadAvatar={onUploadAvatar}
        linkedAccounts={linkedAccounts}
        isLoadingLinkedAccounts={isLoadingLinkedAccounts}
        onConnectAccount={onConnectAccount}
        showLinkedAccounts={showLinkedAccounts}
        hasPasswordCredential={hasPasswordCredential}
        onChangePassword={onChangePassword}
        onVerifyCurrentPassword={onVerifyCurrentPassword}
        onSetupPassword={onSetupPassword}
        canGenerateCliApiKey={canGenerateCliApiKey}
        cliApiKeys={cliApiKeys}
        isLoadingCliApiKeys={isLoadingCliApiKeys}
        isCreatingCliApiKey={isCreatingCliApiKey}
        hasGeneratedCliApiKey={hasGeneratedCliApiKey}
        revokingCliApiKeyId={revokingCliApiKeyId}
        onGenerateCliApiKey={onGenerateCliApiKey}
        onCopyGeneratedCliApiKey={onCopyGeneratedCliApiKey}
        onClearGeneratedCliApiKey={onClearGeneratedCliApiKey}
        onRevokeCliApiKey={onRevokeCliApiKey}
        accountMachinesSlot={accountMachinesSlot}
      />
    );
  }

  return (
    <div {...stylex.props(settingsSurface.container)}>
      {/* Profile: user avatar, display name, connected accounts, password. */}
      {surface === 'account' ? (
        <CompactSection
          title={t('settings.profile.title')}
          headerRight={currentUser?.email || undefined}
        >
          <CompactRow label={t('settings.profile.name')}>
            {canEditUserName ? (
              isEditingUserName ? (
                <Input
                  ref={userNameInputRef}
                  id="profile-name"
                  value={userNameDraft}
                  onChange={(event) => setUserNameDraft(event.target.value)}
                  onBlur={() => {
                    void commitUserNameEdit();
                  }}
                  onKeyDown={handleUserNameKeyDown}
                  maxLength={120}
                  placeholder={t('settings.profile.namePlaceholder')}
                  disabled={isSavingUserName}
                  aria-label={t('settings.profile.name')}
                />
              ) : (
                <Button
                  variant="ghost"
                  size="small"
                  className={stylex.props(styles.valueButton).className}
                  onClick={beginUserNameEdit}
                  disabled={isSavingUserName}
                  aria-label={t('settings.profile.nameEditLabel')}
                >
                  <span {...stylex.props(styles.value)}>
                    {userNameBaseline || t('settings.profile.nameEmpty')}
                  </span>
                  {isSavingUserName ? (
                    <Spinner size="small" />
                  ) : (
                    <Pencil {...stylex.props(styles.valueIcon)} />
                  )}
                </Button>
              )
            ) : (
              <span {...stylex.props(styles.valueText)}>{userNameBaseline || '—'}</span>
            )}
          </CompactRow>
          <CompactRow label={t('settings.profile.avatar.label')}>
            <AvatarEditor
              kind="user"
              name={userNameBaseline}
              image={userImage}
              email={currentUser?.email}
              editable={Boolean(onUploadAvatar)}
              onUpload={(file) => handleUploadAvatar('user', file)}
            />
          </CompactRow>
          {showLinkedAccounts ? (
            <CompactRow label={t('settings.profile.bindings.label')}>
              <LinkedAccountsList
                accounts={linkedAccounts}
                loading={isLoadingLinkedAccounts}
                onConnect={onConnectAccount}
              />
            </CompactRow>
          ) : null}
          {onChangePassword && onSetupPassword ? (
            <CompactRow
              label={t('settings.profile.password.label')}
              helper={
                hasPasswordCredential
                  ? t('settings.profile.password.helper')
                  : t('settings.profile.password.setupHelper')
              }
            >
              <ChangePasswordButton
                hasPassword={hasPasswordCredential}
                onChangePassword={onChangePassword}
                onVerifyCurrentPassword={onVerifyCurrentPassword}
                onSetupPassword={onSetupPassword}
              />
            </CompactRow>
          ) : null}
          <CompactRow label={t('settings.account.signOut')}>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                void onSignOut();
              }}
            >
              <LogOut {...stylex.props(styles.icon)} />
              {t('settings.account.signOut')}
            </Button>
          </CompactRow>
        </CompactSection>
      ) : null}

      {surface === 'account' ? accountMachinesSlot : null}

      {/* Workspace: name + logo. */}
      {isWorkspaceSurface ? (
        <CompactSection title={t('settings.workspace.title')}>
          <CompactRow label={t('settings.account.workspaceName')}>
            {canRenameOrganization ? (
              isEditingWorkspaceName ? (
                <Input
                  ref={workspaceNameInputRef}
                  id="workspace-name"
                  value={workspaceNameDraft}
                  onChange={(event) => setWorkspaceNameDraft(event.target.value)}
                  onBlur={() => {
                    void commitWorkspaceNameEdit();
                  }}
                  onKeyDown={handleWorkspaceNameKeyDown}
                  maxLength={120}
                  placeholder={t('settings.account.workspaceNamePlaceholder')}
                  disabled={isRenamingOrganization}
                  aria-label={t('settings.account.workspaceName')}
                />
              ) : (
                <Button
                  variant="ghost"
                  size="small"
                  className={stylex.props(styles.valueButton).className}
                  onClick={beginWorkspaceNameEdit}
                  disabled={isRenamingOrganization}
                  aria-label={t('settings.account.workspaceNameEditLabel')}
                >
                  <span {...stylex.props(styles.value)}>{workspaceNameBaseline}</span>
                  {isRenamingOrganization ? (
                    <Spinner size="small" />
                  ) : (
                    <Pencil {...stylex.props(styles.valueIcon)} />
                  )}
                </Button>
              )
            ) : (
              <span {...stylex.props(styles.valueText)}>{organization.name}</span>
            )}
          </CompactRow>
          <CompactRow label={t('settings.workspace.avatar.label')}>
            <AvatarEditor
              kind="workspace"
              name={workspaceNameBaseline}
              image={workspaceLogo}
              editable={canRenameOrganization && Boolean(onUploadAvatar)}
              onUpload={(file) => handleUploadAvatar('workspace', file)}
            />
          </CompactRow>
        </CompactSection>
      ) : null}

      {surface === 'account' ? (
        <Dialog.Root open={cliApiKeyDialogOpen} onOpenChange={handleCliApiKeyDialogOpenChange}>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>
                {hasGeneratedCliApiKey
                  ? t('settings.account.cliAuth.createdDialogTitle')
                  : t('settings.account.cliAuth.createDialogTitle')}
              </Dialog.Title>
              <Dialog.Description>
                {hasGeneratedCliApiKey
                  ? t('settings.account.cliAuth.createdDialogDescription')
                  : t('settings.account.cliAuth.createDialogDescription')}
              </Dialog.Description>
            </Dialog.Header>
            {hasGeneratedCliApiKey ? (
              <div {...stylex.props(styles.dialogBody)}>
                <p {...stylex.props(styles.prose)}>{t('settings.account.cliAuth.usageHint')}</p>
                <Button
                  variant="secondary"
                  size="small"
                  className={stylex.props(styles.alignSelfStart).className}
                  onClick={() => {
                    void onCopyGeneratedCliApiKey?.();
                  }}
                  disabled={!onCopyGeneratedCliApiKey}
                >
                  <Copy {...stylex.props(styles.icon)} />
                  {t('settings.account.cliAuth.copyGeneratedButton')}
                </Button>
              </div>
            ) : (
              <div {...stylex.props(styles.field)}>
                <UiField.Label htmlFor="cli-api-key-note">
                  {t('settings.account.cliAuth.noteLabel')}
                </UiField.Label>
                <Input
                  id="cli-api-key-note"
                  value={cliApiKeyNote}
                  onChange={(event) => setCliApiKeyNote(event.target.value)}
                  maxLength={160}
                  placeholder={t('settings.account.cliAuth.notePlaceholder')}
                />
                <UiField.Description>
                  {t('settings.account.cliAuth.noteHelper')}
                </UiField.Description>
              </div>
            )}
            <Dialog.Footer>
              <Button
                variant="secondary"
                size="small"
                onClick={() => handleCliApiKeyDialogOpenChange(false)}
                disabled={isCreatingCliApiKey}
              >
                {hasGeneratedCliApiKey ? t('common.close') : t('common.cancel')}
              </Button>
              {!hasGeneratedCliApiKey && (
                <Button
                  size="small"
                  onClick={() => {
                    void handleCreateCliApiKey();
                  }}
                  disabled={isCreatingCliApiKey || !onGenerateCliApiKey}
                >
                  {isCreatingCliApiKey && <Spinner size="small" />}
                  {t('settings.account.cliAuth.createConfirmButton')}
                </Button>
              )}
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Root>
      ) : null}

      {surface === 'account' ? (
        <AlertDialog.Root
          open={Boolean(cliApiKeyToRevoke)}
          onOpenChange={(open) => {
            if (!open) setCliApiKeyToRevoke(null);
          }}
        >
          <AlertDialog.Content>
            <AlertDialog.Header>
              <AlertDialog.Title>
                {t('settings.account.cliAuth.revokeDialogTitle')}
              </AlertDialog.Title>
              <AlertDialog.Description>
                {t('settings.account.cliAuth.revokeDialogDescription', {
                  note: cliApiKeyToRevoke?.note ?? t('settings.account.cliAuth.recordNoteFallback'),
                })}
              </AlertDialog.Description>
            </AlertDialog.Header>
            <AlertDialog.Footer>
              <AlertDialog.Cancel disabled={Boolean(revokingCliApiKeyId)}>
                {t('common.cancel')}
              </AlertDialog.Cancel>
              <AlertDialog.Action
                onClick={() => {
                  void (async () => {
                    if (!cliApiKeyToRevoke) return;
                    await onRevokeCliApiKey?.(cliApiKeyToRevoke.id);
                    setCliApiKeyToRevoke(null);
                  })();
                }}
                disabled={!cliApiKeyToRevoke || Boolean(revokingCliApiKeyId)}
                variant="destructive"
              >
                {revokingCliApiKeyId ? (
                  <Spinner size="small" />
                ) : (
                  <Trash2 {...stylex.props(styles.icon)} />
                )}
                {t('settings.account.cliAuth.revokeConfirmButton')}
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </AlertDialog.Content>
        </AlertDialog.Root>
      ) : null}

      {/* Members */}
      {isWorkspaceSurface ? (
        <CompactSection
          title={t('workspace.members.title')}
          actions={
            hasAdminPermission && (
              <Button
                icon
                variant="ghost"
                aria-label={t('workspace.members.invite')}
                onClick={() => setInviteDialogOpen(true)}
              >
                <UserPlus {...stylex.props(styles.glyph)} />
              </Button>
            )
          }
        >
          {members.map((member) => {
            const isEditable =
              hasAdminPermission && member.role !== 'owner' && member.userId !== currentUser?.id;

            return (
              <div key={member.id} {...stylex.props(styles.record)}>
                <UserAvatar user={member.user} size="large" />
                <div {...stylex.props(styles.recordText)}>
                  <p {...stylex.props(styles.recordTitle)}>
                    {member.user?.name || '—'}
                    {member.userId === currentUser?.id && (
                      <span {...stylex.props(styles.you)}>
                        ({t('workspace.members.you', 'you')})
                      </span>
                    )}
                  </p>
                  <p {...stylex.props(styles.recordMeta)}>{member.user?.email}</p>
                </div>
                <div {...stylex.props(styles.recordActions)}>
                  {isEditable ? (
                    <Menu.Root>
                      <Menu.Trigger render={<Button variant="ghost" size="mini" />}>
                        {t(`organization.role.${member.role}`)}
                        <ChevronDown {...stylex.props(styles.valueIcon)} />
                      </Menu.Trigger>
                      <Menu.Content align="end">
                        <Menu.Item
                          inset
                          icon={
                            member.role === 'member' ? (
                              <Check {...stylex.props(styles.glyph)} />
                            ) : undefined
                          }
                          onClick={() => {
                            void onUpdateRole(member, 'member');
                          }}
                        >
                          {t('organization.role.member')}
                        </Menu.Item>
                        <Menu.Item
                          inset
                          icon={
                            member.role === 'admin' ? (
                              <Check {...stylex.props(styles.glyph)} />
                            ) : undefined
                          }
                          onClick={() => {
                            void onUpdateRole(member, 'admin');
                          }}
                        >
                          {t('organization.role.admin')}
                        </Menu.Item>
                      </Menu.Content>
                    </Menu.Root>
                  ) : (
                    // A role nobody here can change is a standing fact about the member.
                    <Badge>{t(`organization.role.${member.role}`)}</Badge>
                  )}
                  {isEditable && (
                    <Button
                      variant="ghost"
                      size="small"
                      icon
                      tone="destructive"
                      onClick={() => {
                        setUserToDelete(member.id);
                        setDeleteUserDialogOpen(true);
                      }}
                    >
                      <Trash2 {...stylex.props(styles.glyph)} />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </CompactSection>
      ) : null}

      {/* Pending Invitations */}
      {isWorkspaceSurface && pendingInvitations.length > 0 ? (
        <CompactSection title={t('workspace.invitations.title')}>
          {pendingInvitations.map((invitation) => (
            <div key={invitation.id} {...stylex.props(styles.record)}>
              {/* The invitee has no face yet: the member's circle, holding a mark. */}
              <Avatar.Root size="large">
                <Avatar.Fallback>
                  <Avatar.Glyph>
                    <Mail {...stylex.props(styles.glyph)} />
                  </Avatar.Glyph>
                </Avatar.Fallback>
              </Avatar.Root>
              <div {...stylex.props(styles.recordText)}>
                <p {...stylex.props(styles.recordTitle)}>{invitation.email}</p>
                <div {...stylex.props(styles.inviteMeta)}>
                  <span>{t(`organization.role.${invitation.role}`)}</span>
                  <span {...stylex.props(styles.inviteStatus)}>
                    <Clock {...stylex.props(styles.clock)} />
                    {t(`workspace.invitations.${invitation.status.toLowerCase()}`)}
                  </span>
                </div>
              </div>
              {invitation.status === 'pending' && (
                <div {...stylex.props(styles.recordActions)}>
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={() => {
                      void onCopyInviteLink(getInviteLink(invitation));
                    }}
                  >
                    <Copy {...stylex.props(styles.icon)} />
                    {t('workspace.invitations.copyLink')}
                  </Button>
                  {hasAdminPermission && (
                    <Button
                      variant="ghost"
                      size="small"
                      icon
                      tone="destructive"
                      disabled={cancellingInvitationIds.has(invitation.id)}
                      onClick={() => {
                        void (async () => {
                          setCancellingInvitationIds((prev) => {
                            const next = new Set(prev);
                            next.add(invitation.id);
                            return next;
                          });
                          try {
                            await onCancelInvitation(invitation.id);
                            setPendingInvitations((prev) =>
                              prev.filter((inv) => inv.id !== invitation.id)
                            );
                          } catch {
                            // Error already handled by onCancelInvitation (toast shown)
                          } finally {
                            setCancellingInvitationIds((prev) => {
                              const next = new Set(prev);
                              next.delete(invitation.id);
                              return next;
                            });
                          }
                        })();
                      }}
                    >
                      {cancellingInvitationIds.has(invitation.id) ? (
                        <Spinner size="small" />
                      ) : (
                        <X {...stylex.props(styles.glyph)} />
                      )}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </CompactSection>
      ) : null}

      {isWorkspaceSurface ? workspaceJoinRequestsSlot : null}

      {surface === 'account' && canGenerateCliApiKey ? (
        <CompactSection
          title={t('settings.account.cliAuth.title')}
          description={t('settings.account.cliAuth.description')}
          actions={
            // A header action sits beside the group's name, so it is a ghost; this
            // one keeps its word, because a key glyph alone does not say "generate".
            <Button
              variant="ghost"
              size="small"
              icon={false}
              onClick={() => {
                setCliApiKeyDialogOpen(true);
              }}
              disabled={!onGenerateCliApiKey}
            >
              <KeyRound {...stylex.props(styles.icon)} />
              {t('settings.account.cliAuth.generateButton')}
            </Button>
          }
        >
          {isLoadingCliApiKeys ? (
            <div {...stylex.props(settingsSurface.cardNote, styles.noteLoading)}>
              <Spinner size="small" />
              {t('settings.account.cliAuth.loadingRecords')}
            </div>
          ) : cliApiKeys.length === 0 ? (
            <p {...stylex.props(settingsSurface.cardNote)}>
              {t('settings.account.cliAuth.noRecords')}
            </p>
          ) : (
            cliApiKeys.map((apiKey) => {
              const createdAt = formatCliApiKeyTimestamp(apiKey.createdAt);
              const lastRequest = formatCliApiKeyTimestamp(apiKey.lastRequest);
              const secondaryLine = apiKey.keyPreview || lastRequest;
              const sourceLabel =
                apiKey.source === 'auto'
                  ? t('settings.account.cliAuth.sourceAuto')
                  : apiKey.source === 'manual'
                    ? t('settings.account.cliAuth.sourceManual')
                    : null;

              return (
                <div key={apiKey.id} {...stylex.props(styles.apiKey)}>
                  <div {...stylex.props(styles.apiKeyText)}>
                    <div {...stylex.props(styles.apiKeyHead)}>
                      <p {...stylex.props(styles.apiKeyNote)}>
                        {apiKey.note || t('settings.account.cliAuth.recordNoteFallback')}
                      </p>
                      {sourceLabel && <Badge>{sourceLabel}</Badge>}
                      {createdAt && (
                        <time dateTime={createdAt.dateTime} {...stylex.props(styles.apiKeyTime)}>
                          {createdAt.label}
                        </time>
                      )}
                    </div>
                    {secondaryLine && (
                      <div {...stylex.props(styles.apiKeyMeta)}>
                        {apiKey.keyPreview && (
                          <span {...stylex.props(styles.mono)}>{apiKey.keyPreview}</span>
                        )}
                        {lastRequest && (
                          <span>
                            {t('settings.account.cliAuth.lastUsed', { at: lastRequest.label })}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="small"
                    tone="destructive"
                    className={stylex.props(styles.alignStart).className}
                    onClick={() => setCliApiKeyToRevoke(apiKey)}
                    disabled={revokingCliApiKeyId === apiKey.id}
                  >
                    {revokingCliApiKeyId === apiKey.id ? (
                      <Spinner size="small" />
                    ) : (
                      <Trash2 {...stylex.props(styles.icon)} />
                    )}
                    {t('settings.account.cliAuth.revokeButton')}
                  </Button>
                </div>
              );
            })
          )}
        </CompactSection>
      ) : null}

      {/* Danger Zone */}
      {isWorkspaceSurface ? (
        <CompactSection title={t('workspace.danger.title')} tone="danger">
          {role === 'owner' ? workspaceOwnershipSlot : null}
          {role !== 'owner' && (
            <CompactRow
              label={t('workspace.danger.leaveWorkspace.title')}
              helper={t('workspace.danger.leaveWorkspace.description')}
            >
              <Button
                variant="secondary"
                size="small"
                tone="destructive"
                onClick={() => setLeaveDialogOpen(true)}
              >
                {t('workspace.danger.leaveWorkspace.button')}
              </Button>
            </CompactRow>
          )}
          {role === 'owner' && (
            <CompactRow
              label={t('workspace.danger.deleteWorkspace.title')}
              helper={t('workspace.danger.deleteWorkspace.description')}
            >
              <Button
                variant="secondary"
                size="small"
                tone="destructive"
                onClick={() => {
                  // A live subscription blocks deletion outright; surface the
                  // guidance dialog instead of the type-to-confirm flow (the
                  // backend would reject the delete anyway).
                  if (deleteBillingGuard?.kind === 'active-subscription') {
                    setDeleteBlockedDialogOpen(true);
                    return;
                  }
                  setDeleteDialogOpen(true);
                }}
              >
                {t('workspace.danger.deleteWorkspace.button')}
              </Button>
            </CompactRow>
          )}
        </CompactSection>
      ) : null}

      {/* Invite Dialog.Root */}
      <InviteMemberDialog
        open={inviteDialogOpen}
        onOpenChange={setInviteDialogOpen}
        workspaceName={organization.name}
        memberLimit={memberLimit}
        memberLimitReached={memberLimitReached}
        billingUiAvailable={billingUiAvailable}
        hasAdminPermission={hasAdminPermission}
        seatPreview={seatPreview}
        inviting={inviting}
        onInvite={(email, invitedRole) => {
          void handleInviteMember(email, invitedRole);
        }}
        {...(onOpenBilling ? { onOpenBilling } : {})}
      />

      {/* Remove Member Dialog.Root */}
      <AlertDialog.Root open={deleteUserDialogOpen} onOpenChange={setDeleteUserDialogOpen}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('workspace.removeMember.title')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t('workspace.removeMember.description')}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.cancel')}</AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={() => {
                void handleRemoveMember();
              }}
              variant="destructive"
            >
              {t('common.remove')}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>

      {/* Leave Workspace Dialog.Root */}
      <AlertDialog.Root open={leaveDialogOpen} onOpenChange={setLeaveDialogOpen}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('workspace.danger.leaveWorkspace.confirmTitle')}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t('workspace.danger.leaveWorkspace.confirmDescription', {
                workspace: organization.name,
              })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={isLeaving}>{t('common.cancel')}</AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={() => {
                void (async () => {
                  setIsLeaving(true);
                  try {
                    await onLeaveOrganization();
                  } finally {
                    setIsLeaving(false);
                    setLeaveDialogOpen(false);
                  }
                })();
              }}
              disabled={isLeaving}
              variant="destructive"
            >
              {isLeaving ? (
                <>
                  <Spinner size="small" />
                  {t('common.processing')}
                </>
              ) : (
                t('workspace.danger.leaveWorkspace.confirmButton')
              )}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>

      {/* Paid workspace: deletion blocked until the subscription is canceled */}
      <AlertDialog.Root open={deleteBlockedDialogOpen} onOpenChange={setDeleteBlockedDialogOpen}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t(
                billingUiAvailable
                  ? 'workspace.deletePaidBlockedTitle'
                  : 'workspace.deleteBlockedMobileTitle'
              )}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t(
                billingUiAvailable
                  ? 'workspace.deletePaidBlockedDescription'
                  : 'workspace.deleteBlockedMobileDescription'
              )}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.cancel')}</AlertDialog.Cancel>
            {billingUiAvailable && onOpenBilling ? (
              <AlertDialog.Action
                onClick={() => {
                  setDeleteBlockedDialogOpen(false);
                  onOpenBilling();
                }}
              >
                {t('workspace.deletePaidBlockedGoToBilling')}
              </AlertDialog.Action>
            ) : null}
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>

      {/* Delete Workspace Dialog.Root */}
      <Dialog.Root open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>{t('workspace.danger.deleteWorkspace.confirmTitle')}</Dialog.Title>
            <Dialog.Description>
              {t('workspace.danger.deleteWorkspace.confirmDescription', {
                workspace: organization.name,
              })}
            </Dialog.Description>
          </Dialog.Header>
          <div {...stylex.props(styles.dialogForm)}>
            {billingUiAvailable && deleteBillingGuard?.kind === 'cancel-scheduled' ? (
              <Alert.Root tone="warning">
                <Alert.Description>
                  {t('workspace.deleteCancelingWarning', {
                    date: deleteBillingGuard.formattedPeriodEnd ?? '',
                  })}
                </Alert.Description>
              </Alert.Root>
            ) : null}
            <div {...stylex.props(styles.field)}>
              <UiField.Label htmlFor="confirmText">
                {t('workspace.danger.deleteWorkspace.typeToConfirm', {
                  workspace: organization.name,
                })}
              </UiField.Label>
              <Input
                id="confirmText"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder={t('workspace.danger.deleteWorkspace.inputPlaceholder')}
              />
            </div>
          </div>
          <Dialog.Footer>
            <Button
              variant="secondary"
              onClick={() => {
                setDeleteDialogOpen(false);
                setDeleteConfirmText('');
              }}
              disabled={isDeleting}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void (async () => {
                  if (deleteConfirmText !== organization.name) {
                    return;
                  }
                  setIsDeleting(true);
                  try {
                    await onDeleteOrganization();
                  } finally {
                    setIsDeleting(false);
                    setDeleteDialogOpen(false);
                    setDeleteConfirmText('');
                  }
                })();
              }}
              disabled={isDeleting || deleteConfirmText !== organization.name}
            >
              {isDeleting ? (
                <>
                  <Spinner size="small" />
                  {t('common.processing')}
                </>
              ) : (
                t('workspace.danger.deleteWorkspace.confirmButton')
              )}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>

      {/* Delete Account Dialog.Root */}
      <Dialog.Root
        open={deleteAccountDialogOpen}
        onOpenChange={(open) => {
          if (isDeletingAccount) {
            return;
          }
          setDeleteAccountDialogOpen(open);
          if (!open) {
            setDeleteAccountConfirmText('');
          }
        }}
      >
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>{t('settings.account.accountDeletion.confirmTitle')}</Dialog.Title>
            <Dialog.Description>
              {t('settings.account.accountDeletion.confirmDescription')}
            </Dialog.Description>
          </Dialog.Header>
          <div {...stylex.props(styles.dialogForm)}>
            <div {...stylex.props(styles.field)}>
              <UiField.Label htmlFor="deleteAccountConfirmText">
                {t('settings.account.accountDeletion.typeToConfirm', {
                  email: currentUser?.email ?? '',
                })}
              </UiField.Label>
              <Input
                id="deleteAccountConfirmText"
                value={deleteAccountConfirmText}
                onChange={(e) => setDeleteAccountConfirmText(e.target.value)}
                placeholder={t('settings.account.accountDeletion.inputPlaceholder')}
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
          </div>
          <Dialog.Footer>
            <Button
              variant="secondary"
              onClick={() => {
                setDeleteAccountDialogOpen(false);
                setDeleteAccountConfirmText('');
              }}
              disabled={isDeletingAccount}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void (async () => {
                  if (deleteAccountConfirmText !== currentUser?.email) {
                    return;
                  }
                  setIsDeletingAccount(true);
                  try {
                    await onDeleteAccount();
                  } catch {
                    // Errors are surfaced via toast by the caller; keep the
                    // dialog open so the user can retry.
                    setIsDeletingAccount(false);
                    return;
                  }
                })();
              }}
              disabled={
                isDeletingAccount ||
                !currentUser?.email ||
                deleteAccountConfirmText !== currentUser?.email
              }
            >
              {isDeletingAccount ? (
                <>
                  <Spinner size="small" />
                  {t('common.processing')}
                </>
              ) : (
                t('settings.account.accountDeletion.confirmButton')
              )}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}
