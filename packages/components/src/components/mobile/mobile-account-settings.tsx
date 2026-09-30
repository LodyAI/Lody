import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
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
import { Menu } from '@/ui/menu';
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
              <span className="max-w-[55vw] truncate text-[0.78rem] text-muted-foreground">
                {currentUser.email}
              </span>
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
                  className="h-9 w-full"
                  aria-label={t('settings.profile.name')}
                />
              ) : (
                <button
                  type="button"
                  className="group flex min-w-0 max-w-[60vw] items-center gap-1.5 rounded-md text-right text-[0.95rem] font-medium leading-tight text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-60"
                  onClick={beginUserNameEdit}
                  disabled={isSavingUserName}
                  aria-label={t('settings.profile.nameEditLabel')}
                >
                  <span className="min-w-0 truncate">
                    {userNameBaseline || t('settings.profile.nameEmpty')}
                  </span>
                  {isSavingUserName ? (
                    <Spinner className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                  )}
                </button>
              )
            ) : (
              <span className="truncate text-[0.95rem] text-muted-foreground">
                {userNameBaseline || '—'}
              </span>
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
              <LogOut className="mr-1.5 h-3.5 w-3.5" />
              {t('settings.account.signOut')}
            </Button>
          </MobileSettingsRow>
        </MobileSettingsSection>
      ) : null}

      {surface === 'account' ? accountMachinesSlot : null}

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
                  className="h-9 w-full"
                  aria-label={t('settings.account.workspaceName')}
                />
              ) : (
                <button
                  type="button"
                  className="group flex min-w-0 max-w-[60vw] items-center gap-1.5 rounded-md text-right text-[0.95rem] font-medium leading-tight text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-60"
                  onClick={beginWorkspaceNameEdit}
                  disabled={isRenamingOrganization}
                  aria-label={t('settings.account.workspaceNameEditLabel')}
                >
                  <span className="min-w-0 truncate">{workspaceNameBaseline}</span>
                  {isRenamingOrganization ? (
                    <Spinner className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                  )}
                </button>
              )
            ) : (
              <span className="truncate text-[0.95rem] text-muted-foreground">
                {organization.name}
              </span>
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
                className="h-8 px-2.5"
                onClick={() => setInviteDialogOpen(true)}
              >
                <UserPlus className="mr-1.5 h-3.5 w-3.5" />
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
                className={cn(
                  'flex items-center gap-3 px-4 py-3 text-sm',
                  index > 0 && 'border-t border-border'
                )}
              >
                <UserAvatar user={member.user} size="large" className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.95rem] font-medium leading-tight">
                    {member.user?.name || '—'}
                    {member.userId === currentUser?.id && (
                      <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                        ({t('workspace.members.you', 'you')})
                      </span>
                    )}
                  </p>
                  {member.user?.email ? (
                    <p className="truncate text-[0.78rem] leading-tight text-muted-foreground">
                      {member.user.email}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {isEditable ? (
                    <Menu.Root>
                      <Menu.Trigger render={<Button variant="ghost" size="mini" />}>
                        {t(`organization.role.${member.role}`)}
                        <ChevronDown className="h-3 w-3 opacity-50" />
                      </Menu.Trigger>
                      <Menu.Content align="end">
                        <Menu.Item
                          onClick={() => {
                            void onUpdateRole(member, 'member');
                          }}
                        >
                          <Check
                            className={cn(
                              'mr-2 h-3.5 w-3.5',
                              member.role === 'member' ? 'opacity-100' : 'opacity-0'
                            )}
                          />
                          {t('organization.role.member')}
                        </Menu.Item>
                        <Menu.Item
                          onClick={() => {
                            void onUpdateRole(member, 'admin');
                          }}
                        >
                          <Check
                            className={cn(
                              'mr-2 h-3.5 w-3.5',
                              member.role === 'admin' ? 'opacity-100' : 'opacity-0'
                            )}
                          />
                          {t('organization.role.admin')}
                        </Menu.Item>
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
                      className="h-9 w-9 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        setUserToDelete(member.id);
                        setDeleteUserDialogOpen(true);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
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
              className={cn(
                'flex items-center gap-3 px-4 py-3 text-sm',
                index > 0 && 'border-t border-border'
              )}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                <Mail className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                {/* Emails have no spaces — `truncate` cut long addresses to an
                   unreadable stub on narrow phones; wrap them instead. */}
                <p className="break-all text-[0.95rem] font-medium leading-tight">
                  {invitation.email}
                </p>
                <div className="mt-0.5 flex items-center gap-2 text-[0.72rem] text-muted-foreground">
                  <span>{t(`organization.role.${invitation.role}`)}</span>
                  <span className="inline-flex items-center gap-0.5">
                    <Clock className="h-2.5 w-2.5" />
                    {t(`workspace.invitations.${invitation.status.toLowerCase()}`)}
                  </span>
                </div>
              </div>
              {invitation.status === 'pending' && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    icon
                    aria-label={t('workspace.invitations.copyLink')}
                    className="h-9 w-9 text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      void onCopyInviteLink(getInviteLink(invitation));
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  {hasAdminPermission && (
                    <Button
                      variant="ghost"
                      icon
                      aria-label={t('common.cancel')}
                      className="h-9 w-9 text-muted-foreground hover:text-destructive"
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
                        <Spinner className="h-3.5 w-3.5" />
                      ) : (
                        <X className="h-3.5 w-3.5" />
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
          <div className="mx-3">{workspaceJoinRequestsSlot}</div>
        </MobileSettingsSection>
      ) : null}

      {surface === 'account' && canGenerateCliApiKey ? (
        <MobileSettingsSection
          title={t('settings.account.cliAuth.title')}
          description={t('settings.account.cliAuth.description')}
          actions={
            <Button
              size="small"
              className="h-8 px-2.5"
              onClick={() => {
                setCliApiKeyDialogOpen(true);
              }}
              disabled={!onGenerateCliApiKey}
            >
              <KeyRound className="mr-1.5 h-3.5 w-3.5" />
              {t('settings.account.cliAuth.generateButton')}
            </Button>
          }
        >
          {isLoadingCliApiKeys ? (
            <div className="flex items-center gap-2 px-4 py-3 text-[0.78rem] text-muted-foreground">
              <Spinner className="h-3.5 w-3.5" />
              {t('settings.account.cliAuth.loadingRecords')}
            </div>
          ) : cliApiKeys.length === 0 ? (
            <div className="px-4 py-3 text-[0.78rem] text-muted-foreground">
              {t('settings.account.cliAuth.noRecords')}
            </div>
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
                  className={cn(
                    'flex flex-col gap-3 px-4 py-3 text-sm',
                    index > 0 && 'border-t border-border'
                  )}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                      <p className="truncate text-[0.95rem] font-medium">
                        {apiKey.note || t('settings.account.cliAuth.recordNoteFallback')}
                      </p>
                      {sourceLabel && <Badge>{sourceLabel}</Badge>}
                      {createdAt && (
                        <time
                          dateTime={createdAt.dateTime}
                          className="shrink-0 text-[0.72rem] text-muted-foreground"
                        >
                          {createdAt.label}
                        </time>
                      )}
                    </div>
                    {(apiKey.keyPreview || lastRequest) && (
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[0.72rem] text-muted-foreground">
                        {apiKey.keyPreview && (
                          <span className="font-mono">{apiKey.keyPreview}</span>
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
                        <Spinner className="mr-1.5 h-3.5 w-3.5" />
                      ) : (
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
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
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
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
              <div className="space-y-3 py-4 text-sm">
                <p className="text-muted-foreground">{t('settings.account.cliAuth.usageHint')}</p>
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => {
                    void onCopyGeneratedCliApiKey?.();
                  }}
                  disabled={!onCopyGeneratedCliApiKey}
                >
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  {t('settings.account.cliAuth.copyGeneratedButton')}
                </Button>
              </div>
            ) : (
              <div className="space-y-2 py-4">
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
                <p className="text-xs text-muted-foreground">
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
                  {isCreatingCliApiKey && <Spinner className="mr-1.5 h-3.5 w-3.5" />}
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
                  <Spinner className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
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
              {t('workspace.removeMember.description')}
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
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isLeaving ? (
                <>
                  <Spinner className="mr-2 h-4 w-4" />
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
          <div className="space-y-4 py-4">
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
                  <Spinner className="mr-2 h-4 w-4" />
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
