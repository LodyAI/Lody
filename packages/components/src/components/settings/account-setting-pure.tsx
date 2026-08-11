import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { Invitation } from 'better-auth/plugins';
import type { AvatarKind, CliApiKeyRecord } from '@lody/shared';
import {
  Loader2,
  UserPlus,
  Mail,
  Clock,
  Copy,
  Shield,
  Trash2,
  ChevronDown,
  Check,
  LogOut,
  KeyRound,
  CreditCard,
  Users,
  Pencil,
  X,
} from 'lucide-react';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { UserAvatar } from '../user-avatar';
import type { OrganizationMemberRef, OrganizationMemberRole } from '@/lib/organization-member-role';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { CompactRow, CompactSection } from './compact-layout';
import { AvatarEditor } from './avatar-editor';
import { ChangePasswordButton } from './change-password-button';
import { LinkedAccountsList, type LinkedAccountInfo } from './linked-accounts-list';
import { MobileAccountSettings } from '@/components/mobile/mobile-account-settings';
import { useIsMobile } from '@/hooks/use-mobile';
import { settingContainerClass } from '.';

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
  /** Account-only machine overview supplied by the runtime-aware container. */
  accountMachinesSlot?: ReactNode;
  memberLimit?: number | null;
  memberLimitReached?: boolean;
  billingUiAvailable?: boolean;
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
  accountMachinesSlot,
  memberLimit = null,
  memberLimitReached = false,
  billingUiAvailable = true,
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
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');
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

  const handleInviteMember = async () => {
    if (!inviteEmail.trim()) return;

    setInviting(true);
    try {
      const result = await onInviteMember(inviteEmail, inviteRole);
      if (result) {
        setPendingInvitations((prev) => [...prev, result]);
        setInviteDialogOpen(false);
        setInviteEmail('');
        setInviteRole('member');
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
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin" />
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
        memberLimit={memberLimit}
        memberLimitReached={memberLimitReached}
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
    <div className={settingContainerClass}>
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
                  className="h-8 w-full min-w-0 sm:max-w-md"
                  aria-label={t('settings.profile.name')}
                />
              ) : (
                <button
                  type="button"
                  className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-left font-medium transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-60"
                  onClick={beginUserNameEdit}
                  disabled={isSavingUserName}
                  aria-label={t('settings.profile.nameEditLabel')}
                >
                  <span className="min-w-0 truncate">
                    {userNameBaseline || t('settings.profile.nameEmpty')}
                  </span>
                  {isSavingUserName ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <Pencil className="h-3 w-3 shrink-0 text-muted-foreground" />
                  )}
                </button>
              )
            ) : (
              <span className="truncate font-medium">{userNameBaseline || '—'}</span>
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
              variant="ghost"
              size="sm"
              className="bg-foreground/[0.06] hover:bg-foreground/[0.1]"
              onClick={() => {
                void onSignOut();
              }}
            >
              <LogOut className="mr-1.5 h-3.5 w-3.5" />
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
                  className="h-8 w-full min-w-0 sm:max-w-md"
                  aria-label={t('settings.account.workspaceName')}
                />
              ) : (
                <button
                  type="button"
                  className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-left font-medium transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-60"
                  onClick={beginWorkspaceNameEdit}
                  disabled={isRenamingOrganization}
                  aria-label={t('settings.account.workspaceNameEditLabel')}
                >
                  <span className="min-w-0 truncate">{workspaceNameBaseline}</span>
                  {isRenamingOrganization ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <Pencil className="h-3 w-3 shrink-0 text-muted-foreground" />
                  )}
                </button>
              )
            ) : (
              <span className="truncate font-medium">{organization.name}</span>
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
        <Dialog open={cliApiKeyDialogOpen} onOpenChange={handleCliApiKeyDialogOpenChange}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {hasGeneratedCliApiKey
                  ? t('settings.account.cliAuth.createdDialogTitle')
                  : t('settings.account.cliAuth.createDialogTitle')}
              </DialogTitle>
              <DialogDescription>
                {hasGeneratedCliApiKey
                  ? t('settings.account.cliAuth.createdDialogDescription')
                  : t('settings.account.cliAuth.createDialogDescription')}
              </DialogDescription>
            </DialogHeader>
            {hasGeneratedCliApiKey ? (
              <div className="space-y-3 py-4 text-sm">
                <p className="text-muted-foreground">{t('settings.account.cliAuth.usageHint')}</p>
                <Button
                  variant="outline"
                  size="sm"
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
                <Label htmlFor="cli-api-key-note">{t('settings.account.cliAuth.noteLabel')}</Label>
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
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleCliApiKeyDialogOpenChange(false)}
                disabled={isCreatingCliApiKey}
              >
                {hasGeneratedCliApiKey ? t('common.close') : t('common.cancel')}
              </Button>
              {!hasGeneratedCliApiKey && (
                <Button
                  size="sm"
                  onClick={() => {
                    void handleCreateCliApiKey();
                  }}
                  disabled={isCreatingCliApiKey || !onGenerateCliApiKey}
                >
                  {isCreatingCliApiKey && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  {t('settings.account.cliAuth.createConfirmButton')}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {surface === 'account' ? (
        <AlertDialog
          open={Boolean(cliApiKeyToRevoke)}
          onOpenChange={(open) => {
            if (!open) setCliApiKeyToRevoke(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('settings.account.cliAuth.revokeDialogTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('settings.account.cliAuth.revokeDialogDescription', {
                  note: cliApiKeyToRevoke?.note ?? t('settings.account.cliAuth.recordNoteFallback'),
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={Boolean(revokingCliApiKeyId)}>
                {t('common.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
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
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                )}
                {t('settings.account.cliAuth.revokeConfirmButton')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}

      {/* Members */}
      {isWorkspaceSurface ? (
        <CompactSection
          title={t('workspace.members.title')}
          actions={
            hasAdminPermission && (
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('workspace.members.invite')}
                onClick={() => setInviteDialogOpen(true)}
              >
                <UserPlus className="h-4 w-4" />
              </Button>
            )
          }
        >
          {members.map((member) => {
            const isEditable =
              hasAdminPermission && member.role !== 'owner' && member.userId !== currentUser?.id;

            return (
              <div key={member.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <UserAvatar user={member.user} className="h-7 w-7 shrink-0 text-[11px]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium leading-tight">
                    {member.user?.name || '—'}
                    {member.userId === currentUser?.id && (
                      <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                        ({t('workspace.members.you', 'you')})
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs leading-tight text-muted-foreground">
                    {member.user?.email}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {isEditable ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                          {t(`organization.role.${member.role}`)}
                          <ChevronDown className="h-3 w-3 opacity-50" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
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
                        </DropdownMenuItem>
                        <DropdownMenuItem
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
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <span className="px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      {t(`organization.role.${member.role}`)}
                    </span>
                  )}
                  {isEditable && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
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
        </CompactSection>
      ) : null}

      {/* Pending Invitations */}
      {isWorkspaceSurface && pendingInvitations.length > 0 ? (
        <CompactSection title={t('workspace.invitations.title')}>
          {pendingInvitations.map((invitation) => (
            <div key={invitation.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
                <Mail className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium leading-tight">{invitation.email}</p>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
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
                    size="sm"
                    className="h-7 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      void onCopyInviteLink(getInviteLink(invitation));
                    }}
                  >
                    <Copy className="mr-1 h-3 w-3" />
                    {t('workspace.invitations.copyLink')}
                  </Button>
                  {hasAdminPermission && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
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
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <X className="h-3.5 w-3.5" />
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
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-auto bg-foreground/[0.06] px-2 text-foreground hover:bg-foreground/[0.1]"
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
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('settings.account.cliAuth.loadingRecords')}
            </div>
          ) : cliApiKeys.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              {t('settings.account.cliAuth.noRecords')}
            </div>
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
                <div
                  key={apiKey.id}
                  className="flex flex-col gap-3 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                      <p className="truncate font-medium">
                        {apiKey.note || t('settings.account.cliAuth.recordNoteFallback')}
                      </p>
                      {sourceLabel && (
                        <Badge variant="outline" className="h-5 rounded-md px-1.5 text-[10px]">
                          {sourceLabel}
                        </Badge>
                      )}
                      {createdAt && (
                        <time
                          dateTime={createdAt.dateTime}
                          className="shrink-0 text-xs text-muted-foreground"
                        >
                          {createdAt.label}
                        </time>
                      )}
                    </div>
                    {secondaryLine && (
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
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
                  <Button
                    variant="ghost"
                    size="sm"
                    className="bg-destructive/[0.06] text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setCliApiKeyToRevoke(apiKey)}
                    disabled={revokingCliApiKeyId === apiKey.id}
                  >
                    {revokingCliApiKeyId === apiKey.id ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
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
        <CompactSection title={t('workspace.danger.title')} className="border-destructive/20">
          {role !== 'owner' && (
            <CompactRow
              label={t('workspace.danger.leaveWorkspace.title')}
              helper={t('workspace.danger.leaveWorkspace.description')}
            >
              <Button
                variant="ghost"
                size="sm"
                className="bg-destructive/[0.06] text-destructive hover:bg-destructive/10 hover:text-destructive"
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
                variant="ghost"
                size="sm"
                className="bg-destructive/[0.06] text-destructive hover:bg-destructive/10 hover:text-destructive"
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

      {/* Invite Dialog */}
      <Dialog open={inviteDialogOpen} onOpenChange={setInviteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {memberLimitReached
                ? t(
                    billingUiAvailable
                      ? 'workspace.invite.limitTitle'
                      : 'workspace.invite.mobileLimitTitle'
                  )
                : t('workspace.invite.title')}
            </DialogTitle>
            <DialogDescription>
              {memberLimitReached
                ? t('workspace.invite.limitDescription', { limit: memberLimit ?? 3 })
                : t('workspace.invite.description')}
            </DialogDescription>
          </DialogHeader>
          {memberLimitReached ? (
            <Alert className="my-4">
              <Users />
              <AlertTitle>{t('workspace.invite.limitAlertTitle')}</AlertTitle>
              <AlertDescription>
                {t(
                  billingUiAvailable
                    ? 'workspace.invite.limitAlertDescription'
                    : 'workspace.invite.mobileLimitAlertDescription'
                )}
              </AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="email">{t('workspace.invite.email')}</Label>
                <Input
                  id="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder={t('workspace.invite.emailPlaceholder')}
                  type="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="role">{t('workspace.invite.role')}</Label>
                <Select
                  value={inviteRole}
                  onValueChange={(value) => setInviteRole(value as 'member' | 'admin')}
                >
                  <SelectTrigger className="h-9 w-full sm:w-[220px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">{t('organization.role.member')}</SelectItem>
                    <SelectItem value="admin">
                      <div className="flex items-center">
                        <Shield className="mr-2 h-4 w-4" />
                        <span>{t('organization.role.admin')}</span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setInviteDialogOpen(false)}
              disabled={inviting}
            >
              {memberLimitReached ? t('common.close') : t('common.cancel')}
            </Button>
            {memberLimitReached ? (
              hasAdminPermission &&
              billingUiAvailable &&
              onOpenBilling && (
                <Button
                  size="sm"
                  onClick={() => {
                    setInviteDialogOpen(false);
                    onOpenBilling();
                  }}
                >
                  <CreditCard className="mr-1.5 h-3.5 w-3.5" />
                  {t('workspace.invite.upgradeButton')}
                </Button>
              )
            ) : (
              <Button
                size="sm"
                onClick={() => {
                  void handleInviteMember();
                }}
                disabled={!inviteEmail.trim() || inviting}
              >
                {inviting ? t('common.inviting') : t('common.invite')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Member Dialog */}
      <AlertDialog open={deleteUserDialogOpen} onOpenChange={setDeleteUserDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('workspace.removeMember.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.removeMember.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void handleRemoveMember();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('common.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Leave Workspace Dialog */}
      <AlertDialog open={leaveDialogOpen} onOpenChange={setLeaveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('workspace.danger.leaveWorkspace.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.danger.leaveWorkspace.confirmDescription', {
                workspace: organization.name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isLeaving}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
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
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('common.processing')}
                </>
              ) : (
                t('workspace.danger.leaveWorkspace.confirmButton')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Paid workspace: deletion blocked until the subscription is canceled */}
      <AlertDialog open={deleteBlockedDialogOpen} onOpenChange={setDeleteBlockedDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                billingUiAvailable
                  ? 'workspace.deletePaidBlockedTitle'
                  : 'workspace.deleteBlockedMobileTitle'
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                billingUiAvailable
                  ? 'workspace.deletePaidBlockedDescription'
                  : 'workspace.deleteBlockedMobileDescription'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            {billingUiAvailable && onOpenBilling ? (
              <AlertDialogAction
                onClick={() => {
                  setDeleteBlockedDialogOpen(false);
                  onOpenBilling();
                }}
              >
                {t('workspace.deletePaidBlockedGoToBilling')}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Workspace Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">
              {t('workspace.danger.deleteWorkspace.confirmTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('workspace.danger.deleteWorkspace.confirmDescription', {
                workspace: organization.name,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {billingUiAvailable && deleteBillingGuard?.kind === 'cancel-scheduled' ? (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-950 dark:text-amber-100">
                {t('workspace.deleteCancelingWarning', {
                  date: deleteBillingGuard.formattedPeriodEnd ?? '',
                })}
              </p>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="confirmText">
                {t('workspace.danger.deleteWorkspace.typeToConfirm', {
                  workspace: organization.name,
                })}
              </Label>
              <Input
                id="confirmText"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder={t('workspace.danger.deleteWorkspace.inputPlaceholder')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
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
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('common.processing')}
                </>
              ) : (
                t('workspace.danger.deleteWorkspace.confirmButton')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Account Dialog */}
      <Dialog
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">
              {t('settings.account.accountDeletion.confirmTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('settings.account.accountDeletion.confirmDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="deleteAccountConfirmText">
                {t('settings.account.accountDeletion.typeToConfirm', {
                  email: currentUser?.email ?? '',
                })}
              </Label>
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
          <DialogFooter>
            <Button
              variant="outline"
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
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('common.processing')}
                </>
              ) : (
                t('settings.account.accountDeletion.confirmButton')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
