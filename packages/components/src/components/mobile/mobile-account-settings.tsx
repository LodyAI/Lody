import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import type { AvatarKind, CliApiKeyRecord } from '@lody/shared';
import {
  UserPlus,
  Mail,
  Clock,
  Copy,
  Trash2,
  ChevronDown,
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
import { Menu } from '@/ui/menu';
import { withClassName } from '@/lib/stylex';
import { UserAvatar } from '../user-avatar';
import { isNativeIOSAppShell } from '@/lib/native-platform';
import { Dialog } from '@/ui/dialog';
import { AlertDialog } from '@/ui/dialog';
import { MobileSettingsRow, MobileSettingsSection } from '@/components/mobile/mobile-settings-row';
import { MobileDeleteWorkspaceSheet } from '@/components/mobile/mobile-delete-workspace-sheet';
import { AvatarEditor } from '../settings/avatar-editor';
import { ChangePasswordButton } from '../settings/change-password-button';
import { LinkedAccountsList } from '../settings/linked-accounts-list';
import { InviteMemberDialog, type InviteMemberRole } from '../settings/invite-member-dialog';
import type { AccountSettingsPureProps } from '../settings/account-setting-pure';
// The theme tokens are imported by path, not by the `@/` alias: the StyleX
// compiler links a theme file on its own and does not follow bundler aliases.
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const MONO = 'var(--font-mono, ui-monospace, monospace)';

const styles = stylex.create({
  pendingNameInk: { color: 'hsl(var(--muted-foreground) / 1)' },
  pendingActionSpacing: { marginRight: 'calc(var(--spacing) * 1.5)' },
  pendingAccountDeletionSpacing: { marginRight: 'calc(var(--spacing) * 2)' },
  /** The account's address, in the section's header. */
  email: {
    maxWidth: '55vw',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.78rem',
    color: themeColors.mutedForeground,
  },
  /**
   * The name that opens the inline editor. Its focus ring was a Tailwind
   * `focus-visible:ring-*`, which this app paints as nothing (the global
   * focus rule zeroes Tailwind's ring shadow) — and which also erased the
   * app's own focus ring. The button keeps no focus indicator, as before.
   */
  nameButton: {
    display: 'flex',
    minWidth: 0,
    maxWidth: '60vw',
    alignItems: 'center',
    gap: themeSpace[1.5],
    borderRadius: themeRadius.md,
    textAlign: 'right',
    fontSize: '0.95rem',
    fontWeight: themeFontWeight.medium,
    lineHeight: 1.25,
    // The focus ring was a Tailwind `focus-visible:ring-*`, which painted
    // nothing and erased the app's global focus ring. The button keeps no
    // focus indicator, exactly as before.
    boxShadow: { default: null, ':focus-visible': 'none' },
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    color: { default: themeColors.mutedForeground, ':hover': themeColors.foreground },
    pointerEvents: { default: null, ':disabled': 'none' },
    opacity: { default: null, ':disabled': 0.6 },
  },
  /** The name inside that button. */
  nameValue: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The pencil that says the name is editable. */
  namePencil: {
    height: themeSpace[3.5],
    width: themeSpace[3.5],
    flexShrink: 0,
    color: 'hsl(var(--muted-foreground) / 0.7)',
  },
  /** A plain value in a row, quiet because it is not the row's name. */
  plainValue: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.95rem',
    color: themeColors.mutedForeground,
  },
  /** A list row inside a card: the member, the invitation, the API key. */
  listRow: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[3],
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
  },
  /** The rule between two rows of a card. */
  listRowDivider: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: themeColors.border,
  },
  /** A list row stacked in a column, for a record with its own actions. */
  listStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[3],
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
  },
  /** The text column of a list row: it takes the remaining width. */
  listBody: { minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  /** A record's name. */
  listName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.95rem',
    fontWeight: themeFontWeight.medium,
    lineHeight: 1.25,
  },
  /** A record's secondary line. */
  listMeta: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.78rem',
    lineHeight: 1.25,
    color: themeColors.mutedForeground,
  },
  /** The "(you)" beside the current user's own name. */
  listYou: {
    marginLeft: themeSpace[1.5],
    fontSize: '11px',
    fontWeight: themeFontWeight.normal,
    color: themeColors.mutedForeground,
  },
  /** A row's trailing actions. */
  listActions: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: themeSpace[1] },
  /** The chevron that says a row opens a menu. */
  chevron: { height: themeSpace[3], width: themeSpace[3], opacity: 0.5 },
  /** The mark an invitation carries. */
  inviteMark: {
    display: 'flex',
    height: themeSpace[9],
    width: themeSpace[9],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    backgroundColor: themeColors.muted,
  },
  inviteIcon: { height: themeSpace[4], width: themeSpace[4], color: themeColors.mutedForeground },
  /** An address: it has no spaces, so it wraps rather than truncates. */
  inviteEmail: {
    wordBreak: 'break-all',
    fontSize: '0.95rem',
    fontWeight: themeFontWeight.medium,
    lineHeight: 1.25,
  },
  /** The line under an address: the role, and the invitation's state. */
  inviteMeta: {
    marginTop: themeSpace[0.5],
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
    fontSize: '0.72rem',
    color: themeColors.mutedForeground,
  },
  inviteMetaItem: { display: 'inline-flex', alignItems: 'center', gap: themeSpace[0.5] },
  inviteClock: { height: themeSpace[2.5], width: themeSpace[2.5] },
  /** The CLI key list's own rows. */
  keyRow: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3],
    fontSize: '0.78rem',
    color: themeColors.mutedForeground,
  },
  keyEmpty: {
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3],
    fontSize: '0.78rem',
    color: themeColors.mutedForeground,
  },
  keyBody: { minWidth: 0 },
  keyTitleLine: {
    display: 'flex',
    minWidth: 0,
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: themeSpace[2],
    rowGap: themeSpace[1],
  },
  keyNote: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.95rem',
    fontWeight: themeFontWeight.medium,
  },
  keyTime: { flexShrink: 0, fontSize: '0.72rem', color: themeColors.mutedForeground },
  keyDetails: {
    marginTop: themeSpace[1],
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: themeSpace[3],
    rowGap: themeSpace[1],
    fontSize: '0.72rem',
    color: themeColors.mutedForeground,
  },
  keyPreview: { fontFamily: MONO },
  /** The dialog's own copy. */
  dialogBody: {
    paddingBlock: themeSpace[4],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
  },
  /** The dialog's field block. */
  dialogField: { paddingBlock: themeSpace[4] },
  /** The hint under a generated key; it carries the gap to the button below. */
  usageNote: { color: themeColors.mutedForeground, marginBottom: themeSpace[3] },
  dialogNote: {
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
  /** The icon inside a button, with the button's own gap before it. */
  buttonIcon: {
    marginRight: themeSpace[1.5],
    height: themeSpace[3.5],
    width: themeSpace[3.5],
  },
  /** The icon inside a round button. */
  smallIcon: { height: themeSpace[3.5], width: themeSpace[3.5] },
  /** The join-requests block keeps the page's own inset. */
  workspaceInset: { marginInline: themeSpace[3] },
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

export function MobileAccountSettings({
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
  accountBillingSlot,
  memberLimit = null,
  memberLimitReached = false,
  billingUiAvailable = true,
  seatPreview,
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
  /* Delete-workspace state (typed confirmation + isDeleting spinner)
     lives inside `MobileDeleteWorkspaceSheet` itself; this component
     only tracks open/closed. */
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteBlockedDialogOpen, setDeleteBlockedDialogOpen] = useState(false);
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

  const [userNameDraft, setUserNameDraft] = useState(currentUser?.name ?? '');
  const [userNameBaseline, setUserNameBaseline] = useState(currentUser?.name ?? '');
  const [isEditingUserName, setIsEditingUserName] = useState(false);
  const [isSavingUserName, setIsSavingUserName] = useState(false);
  const userNameInputRef = useRef<HTMLInputElement>(null);
  const [userImage, setUserImage] = useState<string | null | undefined>(currentUser?.image ?? null);
  const [workspaceLogo, setWorkspaceLogo] = useState<string | null | undefined>(
    organization.logo ?? null
  );
  // In-app account deletion is an Apple App Store requirement; only surface it
  // on the native iOS app (not Android or mobile web).
  const showAccountDeletion = isNativeIOSAppShell();

  useEffect(() => {
    setPendingInvitations(initialPendingInvitations);
  }, [initialPendingInvitations]);

  useEffect(() => {
    setWorkspaceNameDraft(organization.name);
    setWorkspaceNameBaseline(organization.name);
  }, [organization.name]);

  useEffect(() => {
    if (!isEditingWorkspaceName) return;
    workspaceNameInputRef.current?.focus();
    workspaceNameInputRef.current?.select();
  }, [isEditingWorkspaceName]);

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

  return (
    <>
      {surface === 'account' ? (
        <MobileSettingsSection
          title={t('settings.profile.title')}
          actions={
            currentUser?.email ? (
              <span {...stylex.props(styles.email)}>{currentUser.email}</span>
            ) : undefined
          }
        >
          <MobileSettingsRow
            label={t('settings.profile.name')}
            stack={canEditUserName && isEditingUserName}
          >
            {canEditUserName ? (
              isEditingUserName ? (
                <Input
                  ref={userNameInputRef}
                  id="profile-name-mobile"
                  value={userNameDraft}
                  onChange={(event) => setUserNameDraft(event.target.value)}
                  onBlur={() => {
                    void commitUserNameEdit();
                  }}
                  onKeyDown={handleUserNameKeyDown}
                  maxLength={120}
                  placeholder={t('settings.profile.namePlaceholder')}
                  disabled={isSavingUserName}
                  className="h-9"
                  aria-label={t('settings.profile.name')}
                />
              ) : (
                <button
                  type="button"
                  {...stylex.props(styles.nameButton)}
                  onClick={beginUserNameEdit}
                  disabled={isSavingUserName}
                  aria-label={t('settings.profile.nameEditLabel')}
                >
                  <span {...stylex.props(styles.nameValue)}>
                    {userNameBaseline || t('settings.profile.nameEmpty')}
                  </span>
                  {isSavingUserName ? (
                    <Spinner
                      diameter="calc(var(--spacing) * 3.5)"
                      className={stylex.props(styles.pendingNameInk).className}
                    />
                  ) : (
                    <Pencil {...stylex.props(styles.namePencil)} />
                  )}
                </button>
              )
            ) : (
              <span {...stylex.props(styles.plainValue)}>{userNameBaseline || '—'}</span>
            )}
          </MobileSettingsRow>
          <MobileSettingsRow label={t('settings.profile.avatar.label')} hasDivider>
            <AvatarEditor
              kind="user"
              name={userNameBaseline}
              image={userImage}
              email={currentUser?.email}
              editable={Boolean(onUploadAvatar)}
              onUpload={(file) => handleUploadAvatar('user', file)}
            />
          </MobileSettingsRow>
          {showLinkedAccounts ? (
            <MobileSettingsRow label={t('settings.profile.bindings.label')} hasDivider>
              <LinkedAccountsList
                accounts={linkedAccounts}
                loading={isLoadingLinkedAccounts}
                onConnect={onConnectAccount}
              />
            </MobileSettingsRow>
          ) : null}
          {onChangePassword && onSetupPassword ? (
            <MobileSettingsRow
              label={t('settings.profile.password.label')}
              helper={
                hasPasswordCredential
                  ? t('settings.profile.password.helper')
                  : t('settings.profile.password.setupHelper')
              }
              hasDivider
            >
              <ChangePasswordButton
                hasPassword={hasPasswordCredential}
                onChangePassword={onChangePassword}
                onVerifyCurrentPassword={onVerifyCurrentPassword}
                onSetupPassword={onSetupPassword}
              />
            </MobileSettingsRow>
          ) : null}
          <MobileSettingsRow label={t('settings.account.signOut')} hasDivider>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                void onSignOut();
              }}
            >
              <LogOut {...stylex.props(styles.buttonIcon)} />
              {t('settings.account.signOut')}
            </Button>
          </MobileSettingsRow>
        </MobileSettingsSection>
      ) : null}

      {surface === 'account' ? (
        <>
          {accountMachinesSlot}
          {accountBillingSlot}
        </>
      ) : null}

      {isWorkspaceSurface ? (
        <MobileSettingsSection title={t('settings.workspace.title')}>
          <MobileSettingsRow
            label={t('settings.account.workspaceName')}
            stack={canRenameOrganization && isEditingWorkspaceName}
          >
            {canRenameOrganization ? (
              isEditingWorkspaceName ? (
                <Input
                  ref={workspaceNameInputRef}
                  id="workspace-name-mobile"
                  value={workspaceNameDraft}
                  onChange={(event) => setWorkspaceNameDraft(event.target.value)}
                  onBlur={() => {
                    void commitWorkspaceNameEdit();
                  }}
                  onKeyDown={handleWorkspaceNameKeyDown}
                  maxLength={120}
                  placeholder={t('settings.account.workspaceNamePlaceholder')}
                  disabled={isRenamingOrganization}
                  className="h-9"
                  aria-label={t('settings.account.workspaceName')}
                />
              ) : (
                <button
                  type="button"
                  {...stylex.props(styles.nameButton)}
                  onClick={beginWorkspaceNameEdit}
                  disabled={isRenamingOrganization}
                  aria-label={t('settings.account.workspaceNameEditLabel')}
                >
                  <span {...stylex.props(styles.nameValue)}>{workspaceNameBaseline}</span>
                  {isRenamingOrganization ? (
                    <Spinner
                      diameter="calc(var(--spacing) * 3.5)"
                      className={stylex.props(styles.pendingNameInk).className}
                    />
                  ) : (
                    <Pencil {...stylex.props(styles.namePencil)} />
                  )}
                </button>
              )
            ) : (
              <span {...stylex.props(styles.plainValue)}>{organization.name}</span>
            )}
          </MobileSettingsRow>
          <MobileSettingsRow label={t('settings.workspace.avatar.label')} hasDivider>
            <AvatarEditor
              kind="workspace"
              name={workspaceNameBaseline}
              image={workspaceLogo}
              editable={canRenameOrganization && Boolean(onUploadAvatar)}
              onUpload={(file) => handleUploadAvatar('workspace', file)}
            />
          </MobileSettingsRow>
        </MobileSettingsSection>
      ) : null}

      {isWorkspaceSurface ? (
        <MobileSettingsSection
          title={t('workspace.members.title')}
          actions={
            hasAdminPermission ? (
              <Button
                size="small"
                variant="secondary"
                height="calc(var(--spacing) * 8)"
                className="px-2.5"
                onClick={() => setInviteDialogOpen(true)}
              >
                <UserPlus {...stylex.props(styles.buttonIcon)} />
                {t('workspace.members.invite')}
              </Button>
            ) : undefined
          }
        >
          {members.map((member, index) => {
            const isEditable =
              hasAdminPermission && member.role !== 'owner' && member.userId !== currentUser?.id;

            return (
              <div
                key={member.id}
                {...stylex.props(styles.listRow, index > 0 && styles.listRowDivider)}
              >
                <UserAvatar user={member.user} size="large" />
                <div {...stylex.props(styles.listBody)}>
                  <p {...stylex.props(styles.listName)}>
                    {member.user?.name || '—'}
                    {member.userId === currentUser?.id && (
                      <span {...stylex.props(styles.listYou)}>
                        ({t('workspace.members.you', 'you')})
                      </span>
                    )}
                  </p>
                  {member.user?.email ? (
                    <p {...stylex.props(styles.listMeta)}>{member.user.email}</p>
                  ) : null}
                </div>
                <div {...stylex.props(styles.listActions)}>
                  {isEditable ? (
                    <Menu.Root>
                      <Menu.Trigger render={<Button variant="ghost" size="mini" />}>
                        {t(`organization.role.${member.role}`)}
                        <ChevronDown {...stylex.props(styles.chevron)} />
                      </Menu.Trigger>
                      <Menu.Content align="end">
                        <Menu.RadioGroup
                          value={member.role}
                          onValueChange={(nextRole) => {
                            if (nextRole === 'member' || nextRole === 'admin') {
                              void onUpdateRole(member, nextRole);
                            }
                          }}
                        >
                          <Menu.RadioItem value="member" indicator="check">
                            {t('organization.role.member')}
                          </Menu.RadioItem>
                          <Menu.RadioItem value="admin" indicator="check">
                            {t('organization.role.admin')}
                          </Menu.RadioItem>
                        </Menu.RadioGroup>
                      </Menu.Content>
                    </Menu.Root>
                  ) : (
                    <Badge>{t(`organization.role.${member.role}`)}</Badge>
                  )}
                  {isEditable && (
                    <Button
                      variant="ghost"
                      icon
                      aria-label={t('workspace.removeMember.title')}
                      height="calc(var(--spacing) * 9)"
                      width="calc(var(--spacing) * 9)"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        setUserToDelete(member.id);
                        setDeleteUserDialogOpen(true);
                      }}
                    >
                      <Trash2 {...stylex.props(styles.smallIcon)} />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </MobileSettingsSection>
      ) : null}

      {isWorkspaceSurface && pendingInvitations.length > 0 ? (
        <MobileSettingsSection title={t('workspace.invitations.title')}>
          {pendingInvitations.map((invitation, index) => (
            <div
              key={invitation.id}
              {...stylex.props(styles.listRow, index > 0 && styles.listRowDivider)}
            >
              <div {...stylex.props(styles.inviteMark)}>
                <Mail {...stylex.props(styles.inviteIcon)} />
              </div>
              <div {...stylex.props(styles.listBody)}>
                {/* Emails have no spaces — `truncate` cut long addresses to an
                   unreadable stub on narrow phones; wrap them instead. */}
                <p {...stylex.props(styles.inviteEmail)}>{invitation.email}</p>
                <div {...stylex.props(styles.inviteMeta)}>
                  <span>{t(`organization.role.${invitation.role}`)}</span>
                  <span {...stylex.props(styles.inviteMetaItem)}>
                    <Clock {...stylex.props(styles.inviteClock)} />
                    {t(`workspace.invitations.${invitation.status.toLowerCase()}`)}
                  </span>
                </div>
              </div>
              {invitation.status === 'pending' && (
                <div {...stylex.props(styles.listActions)}>
                  <Button
                    variant="ghost"
                    icon
                    aria-label={t('workspace.invitations.copyLink')}
                    height="calc(var(--spacing) * 9)"
                    width="calc(var(--spacing) * 9)"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      void onCopyInviteLink(getInviteLink(invitation));
                    }}
                  >
                    <Copy {...stylex.props(styles.smallIcon)} />
                  </Button>
                  {hasAdminPermission && (
                    <Button
                      variant="ghost"
                      icon
                      aria-label={t('common.cancel')}
                      height="calc(var(--spacing) * 9)"
                      width="calc(var(--spacing) * 9)"
                      className="text-muted-foreground hover:text-destructive"
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
                        <Spinner diameter="calc(var(--spacing) * 3.5)" />
                      ) : (
                        <X {...stylex.props(styles.smallIcon)} />
                      )}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </MobileSettingsSection>
      ) : null}

      {isWorkspaceSurface && workspaceJoinRequestsSlot ? (
        <MobileSettingsSection noCard>
          <div {...stylex.props(styles.workspaceInset)}>{workspaceJoinRequestsSlot}</div>
        </MobileSettingsSection>
      ) : null}

      {surface === 'account' && canGenerateCliApiKey ? (
        <MobileSettingsSection
          title={t('settings.account.cliAuth.title')}
          description={t('settings.account.cliAuth.description')}
          actions={
            <Button
              size="small"
              height="calc(var(--spacing) * 8)"
              className="px-2.5"
              onClick={() => {
                setCliApiKeyDialogOpen(true);
              }}
              disabled={!onGenerateCliApiKey}
            >
              <KeyRound {...stylex.props(styles.buttonIcon)} />
              {t('settings.account.cliAuth.generateButton')}
            </Button>
          }
        >
          {isLoadingCliApiKeys ? (
            <div {...stylex.props(styles.keyRow)}>
              <Spinner diameter="calc(var(--spacing) * 3.5)" />
              {t('settings.account.cliAuth.loadingRecords')}
            </div>
          ) : cliApiKeys.length === 0 ? (
            <div {...stylex.props(styles.keyEmpty)}>{t('settings.account.cliAuth.noRecords')}</div>
          ) : (
            cliApiKeys.map((apiKey, index) => {
              const createdAt = formatCliApiKeyTimestamp(apiKey.createdAt);
              const lastRequest = formatCliApiKeyTimestamp(apiKey.lastRequest);
              const sourceLabel =
                apiKey.source === 'auto'
                  ? t('settings.account.cliAuth.sourceAuto')
                  : apiKey.source === 'manual'
                    ? t('settings.account.cliAuth.sourceManual')
                    : null;

              return (
                <div
                  key={apiKey.id}
                  {...stylex.props(styles.listStack, index > 0 && styles.listRowDivider)}
                >
                  <div {...stylex.props(styles.keyBody)}>
                    <div {...stylex.props(styles.keyTitleLine)}>
                      <p {...stylex.props(styles.keyNote)}>
                        {apiKey.note || t('settings.account.cliAuth.recordNoteFallback')}
                      </p>
                      {sourceLabel && <Badge>{sourceLabel}</Badge>}
                      {createdAt && (
                        <time dateTime={createdAt.dateTime} {...stylex.props(styles.keyTime)}>
                          {createdAt.label}
                        </time>
                      )}
                    </div>
                    {(apiKey.keyPreview || lastRequest) && (
                      <div {...stylex.props(styles.keyDetails)}>
                        {apiKey.keyPreview && (
                          <span {...stylex.props(styles.keyPreview)}>{apiKey.keyPreview}</span>
                        )}
                        {lastRequest && (
                          <span>
                            {t('settings.account.cliAuth.lastUsed', { at: lastRequest.label })}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div>
                    <Button
                      variant="secondary"
                      size="small"
                      className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setCliApiKeyToRevoke(apiKey)}
                      disabled={revokingCliApiKeyId === apiKey.id}
                    >
                      {revokingCliApiKeyId === apiKey.id ? (
                        <Spinner
                          diameter="calc(var(--spacing) * 3.5)"
                          className={stylex.props(styles.pendingActionSpacing).className}
                        />
                      ) : (
                        <Trash2 {...stylex.props(styles.buttonIcon)} />
                      )}
                      {t('settings.account.cliAuth.revokeButton')}
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </MobileSettingsSection>
      ) : null}

      {isWorkspaceSurface ? (
        <MobileSettingsSection title={t('workspace.danger.title')}>
          {role === 'owner' ? workspaceOwnershipSlot : null}
          {role !== 'owner' && (
            <MobileSettingsRow
              label={t('workspace.danger.leaveWorkspace.title')}
              helper={t('workspace.danger.leaveWorkspace.description')}
              stack
            >
              <Button
                variant="secondary"
                size="small"
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setLeaveDialogOpen(true)}
              >
                {t('workspace.danger.leaveWorkspace.button')}
              </Button>
            </MobileSettingsRow>
          )}
          {role === 'owner' && (
            <MobileSettingsRow
              label={t('workspace.danger.deleteWorkspace.title')}
              helper={t('workspace.danger.deleteWorkspace.description')}
              stack
            >
              <Button
                variant="secondary"
                size="small"
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => {
                  // A live subscription blocks deletion; explain instead of
                  // letting the backend reject the delete.
                  if (deleteBillingGuard?.kind === 'active-subscription') {
                    setDeleteBlockedDialogOpen(true);
                    return;
                  }
                  setDeleteDialogOpen(true);
                }}
              >
                {t('workspace.danger.deleteWorkspace.button')}
              </Button>
            </MobileSettingsRow>
          )}
        </MobileSettingsSection>
      ) : null}

      {surface === 'account' && showAccountDeletion ? (
        <MobileSettingsSection title={t('settings.account.accountDeletion.title')}>
          <MobileSettingsRow
            label={t('settings.account.accountDeletion.title')}
            helper={t('settings.account.accountDeletion.description')}
            stack
          >
            <Button
              variant="secondary"
              size="small"
              className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setDeleteAccountDialogOpen(true)}
            >
              <Trash2 {...stylex.props(styles.buttonIcon)} />
              {t('settings.account.accountDeletion.button')}
            </Button>
          </MobileSettingsRow>
        </MobileSettingsSection>
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
                <p {...stylex.props(styles.usageNote)}>{t('settings.account.cliAuth.usageHint')}</p>
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => {
                    void onCopyGeneratedCliApiKey?.();
                  }}
                  disabled={!onCopyGeneratedCliApiKey}
                >
                  <Copy {...stylex.props(styles.buttonIcon)} />
                  {t('settings.account.cliAuth.copyGeneratedButton')}
                </Button>
              </div>
            ) : (
              /* `space-y-2` stays a Tailwind class: StyleX has no descendant
                 selector, and the gap belongs to the field's own label. */
              <div {...withClassName(stylex.props(styles.dialogField), 'space-y-2')}>
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
                <p {...stylex.props(styles.dialogNote)}>
                  {t('settings.account.cliAuth.noteHelper')}
                </p>
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
                  {isCreatingCliApiKey && (
                    <Spinner
                      diameter="calc(var(--spacing) * 3.5)"
                      className={stylex.props(styles.pendingActionSpacing).className}
                    />
                  )}
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
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {revokingCliApiKeyId ? (
                  <Spinner
                    diameter="calc(var(--spacing) * 3.5)"
                    className={stylex.props(styles.pendingActionSpacing).className}
                  />
                ) : (
                  <Trash2 {...stylex.props(styles.buttonIcon)} />
                )}
                {t('settings.account.cliAuth.revokeConfirmButton')}
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </AlertDialog.Content>
        </AlertDialog.Root>
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
      />

      {/* Remove Member Dialog.Root */}
      <AlertDialog.Root open={deleteUserDialogOpen} onOpenChange={setDeleteUserDialogOpen}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('workspace.removeMember.title')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t('workspace.removeMember.description')}{' '}
              {billingUiAvailable ? t('billing.seatRemovalConsequences') : null}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.cancel')}</AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={() => {
                void handleRemoveMember();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
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
              })}{' '}
              {billingUiAvailable ? t('billing.seatRemovalConsequences') : null}
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
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isLeaving ? (
                <>
                  <Spinner
                    diameter="calc(var(--spacing) * 4)"
                    className={stylex.props(styles.pendingAccountDeletionSpacing).className}
                  />
                  {t('common.processing')}
                </>
              ) : (
                t('workspace.danger.leaveWorkspace.confirmButton')
              )}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>

      {/* Delete Workspace — mobile-native bottom sheet replaces the
          centered Dialog.Root so the destructive flow stays in the same
          visual family as the rest of the mobile chrome. The sheet
          owns its own type-to-confirm state and `isDeleting` spinner
          state; we just pass through the workspace name + the
          `onDeleteOrganization` callback. */}
      <MobileDeleteWorkspaceSheet
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        workspaceName={organization.name}
        onConfirm={onDeleteOrganization}
        warningText={billingUiAvailable ? t('billing.workspaceDeletionCharges') : null}
      />

      {/* Workspaces with active billing must be managed outside the mobile app. */}
      <AlertDialog.Root open={deleteBlockedDialogOpen} onOpenChange={setDeleteBlockedDialogOpen}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('workspace.deleteBlockedMobileTitle')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t('workspace.deleteBlockedMobileDescription')}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.close')}</AlertDialog.Cancel>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>

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
            <Dialog.Title className="text-destructive">
              {t('settings.account.accountDeletion.confirmTitle')}
            </Dialog.Title>
            <Dialog.Description>
              {t('settings.account.accountDeletion.confirmDescription')}
            </Dialog.Description>
          </Dialog.Header>
          <div {...stylex.props(styles.dialogField)}>
            {/* `space-y-2` stays a Tailwind class: StyleX has no descendant
                selector, and the gap belongs to the field's own label. */}
            <div className="space-y-2">
              <UiField.Label htmlFor="mobileDeleteAccountConfirmText">
                {t('settings.account.accountDeletion.typeToConfirm', {
                  email: currentUser?.email ?? '',
                })}
              </UiField.Label>
              <Input
                id="mobileDeleteAccountConfirmText"
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
                    setIsDeletingAccount(false);
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
                  <Spinner
                    diameter="calc(var(--spacing) * 4)"
                    className={stylex.props(styles.pendingAccountDeletionSpacing).className}
                  />
                  {t('common.processing')}
                </>
              ) : (
                t('settings.account.accountDeletion.confirmButton')
              )}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
