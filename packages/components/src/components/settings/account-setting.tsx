import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from '@tanstack/react-router';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useCloudQuery } from '@lody/platform/react';
import { Invitation } from 'better-auth/plugins';
import { toast } from 'sonner';
import type { AvatarKind, CliApiKeyRecord, WorkspaceId } from '@lody/shared';
import { uploadAvatarImage } from '@/lib/avatar-upload';
import { verifyCurrentPassword } from '@/lib/verify-password';
import type { LinkedAccountInfo } from './linked-accounts-list';
import { useOrganization } from '@/hooks/useOrganization';
import { useStableSession } from '@/hooks/useStableSession';
import { useAuthClient, useAuthSignOut } from '../../providers/convex-provider';
import { getAppShareUrl } from '@/lib/app-location';
import { isElectronRenderer } from '@/lib/electron';
import { isNativeAppShell } from '@/lib/native-platform';
import { useAppCapability } from '@/lib/app-platform';
import { clearPreferredWorkspaceSlugIfMatch } from '@/lib/workspace';
import { generateWebCliApiKey, listWebCliApiKeys, revokeWebCliApiKey } from '@/lib/cli-api-key';
import {
  buildOrganizationMemberRemovalRequest,
  buildOrganizationMemberRoleUpdateRequest,
  type OrganizationMemberRef,
  type OrganizationMemberRole,
} from '@/lib/organization-member-role';
import {
  AccountSettingsPure,
  type AccountSettingsSurface,
  type WorkspaceDeleteBillingGuard,
} from './account-setting-pure';
import { WorkspaceJoinRequestsSettings } from './workspace-join-requests-settings';
import { AccountMachinesOverview } from './account-machines-overview';

const getInviteLink = (invitation: Invitation) => getAppShareUrl(`/invite/${invitation.id}`);
const FREE_WORKSPACE_MEMBER_LIMIT_REACHED_CODE = 'free_workspace_member_limit_reached';

export function AccountSettingsComponent({
  surface = 'account',
}: {
  surface?: AccountSettingsSurface;
}) {
  // Personal account and workspace administration are cloud-account surfaces.
  // Registry-level gating hides their tabs without `cloudAccount`; this is the
  // safety net for direct and legacy deep links.
  const cloudAccountAvailable = useAppCapability('cloudAccount');
  if (!cloudAccountAvailable) {
    return null;
  }
  return <CloudAccountSettings surface={surface} />;
}

function CloudAccountSettings({ surface }: { surface: AccountSettingsSurface }) {
  const { t } = useTranslation();
  const authClient = useAuthClient();
  const signOut = useAuthSignOut();
  const router = useRouter();
  const {
    activeOrganization,
    organizations,
    loading: orgLoading,
    role,
    hasAdminPermission,
    deleteOrganization,
    leaveOrganization,
    updateOrganization,
    refetchActiveOrganization,
  } = useOrganization();
  const { data: session, rawData: rawSession, refetch: refetchSession } = useStableSession();
  const currentUser = session?.user ?? null;
  const currentUserId = currentUser?.id ?? null;
  const activeOrganizationId = activeOrganization?.id;
  const memberLimitState = useCloudQuery(
    cloudOperations.billing.getWorkspaceMemberLimitState,
    activeOrganizationId ? { workspaceId: activeOrganizationId } : 'skip'
  );
  // Deleting a paid workspace needs a billing-aware guard: a live subscription
  // blocks deletion (cancel first); a cancel-scheduled one gets a warning that
  // deleting now ends it immediately.
  const billingOverview = useCloudQuery(
    cloudOperations.billing.getBillingOverview,
    activeOrganizationId ? { workspaceId: activeOrganizationId } : 'skip'
  );
  const deleteBillingGuard: WorkspaceDeleteBillingGuard | null = useMemo(() => {
    if (
      !billingOverview ||
      billingOverview.effectivePlanTier === 'free' ||
      billingOverview.entitlementSource === 'stripe_gift'
    ) {
      return null;
    }
    if (billingOverview.cancelAtPeriodEnd) {
      return {
        kind: 'cancel-scheduled',
        formattedPeriodEnd: billingOverview.currentPeriodEnd
          ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
              new Date(billingOverview.currentPeriodEnd)
            )
          : null,
      };
    }
    return { kind: 'active-subscription' };
  }, [billingOverview]);

  const sortedMembers = useMemo(() => {
    const members = activeOrganization?.members ?? [];
    if (!currentUserId || members.length === 0) {
      return members;
    }

    const currentUserIndex = members.findIndex((member) => member.userId === currentUserId);
    if (currentUserIndex <= 0) {
      return members;
    }

    const currentUserMember = members[currentUserIndex];
    if (!currentUserMember) {
      return members;
    }

    return [
      currentUserMember,
      ...members.slice(0, currentUserIndex),
      ...members.slice(currentUserIndex + 1),
    ];
  }, [activeOrganization?.members, currentUserId]);

  const [pendingInvitations, setPendingInvitations] = useState<Invitation[]>([]);
  const [memberLimitReachedFromError, setMemberLimitReachedFromError] = useState(false);
  const [cliApiKeys, setCliApiKeys] = useState<CliApiKeyRecord[]>([]);
  const [isLoadingCliApiKeys, setIsLoadingCliApiKeys] = useState(false);
  const [isCreatingCliApiKey, setIsCreatingCliApiKey] = useState(false);
  const [generatedCliApiKey, setGeneratedCliApiKey] = useState<string | null>(null);
  const [revokingCliApiKeyId, setRevokingCliApiKeyId] = useState<string | null>(null);
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccountInfo[]>([]);
  const [isLoadingLinkedAccounts, setIsLoadingLinkedAccounts] = useState(false);
  const sessionToken = rawSession?.session?.token ?? session?.session?.token ?? null;
  const authBaseUrl = import.meta.env.VITE_CONVEX_SITE_URL;
  const canGenerateCliApiKey = Boolean(authBaseUrl && sessionToken);
  const billingUiAvailable = !isNativeAppShell();
  // OAuth account linking uses a same-origin redirect that only works in a real
  // web browser. The Electron/native OAuth proxy only supports sign-in (not
  // linkSocial), so the flow would dead-end on a one-time-token page. Gate the
  // connect affordance to the browser.
  const canLinkOAuthAccounts = !isElectronRenderer() && !isNativeAppShell();

  const listOrganizationInvitations = useCallback(
    async (organizationId: string) => {
      return await authClient.organization.listInvitations({
        query: {
          organizationId,
        },
      });
    },
    [authClient]
  );

  useEffect(() => {
    if (!activeOrganizationId) {
      setPendingInvitations([]);
      return;
    }
    const fetchPendingInvitations = async () => {
      const { data: invitations } = await listOrganizationInvitations(activeOrganizationId);
      setPendingInvitations(
        invitations?.filter((invitation) => invitation.status === 'pending') || []
      );
    };
    void fetchPendingInvitations();
  }, [activeOrganizationId, listOrganizationInvitations]);

  useEffect(() => {
    if (memberLimitState?.canInvite === true) {
      setMemberLimitReachedFromError(false);
    }
  }, [memberLimitState?.canInvite]);

  useEffect(() => {
    setMemberLimitReachedFromError(false);
  }, [activeOrganizationId]);

  const refreshCliApiKeys = useCallback(async () => {
    if (!authBaseUrl || !sessionToken) {
      setCliApiKeys([]);
      setIsLoadingCliApiKeys(false);
      return;
    }

    setIsLoadingCliApiKeys(true);
    try {
      const result = await listWebCliApiKeys({ authBaseUrl, sessionToken });
      if (!result.ok) {
        toast.error(t('settings.account.cliAuth.loadFailed'), {
          description: result.error,
        });
        return;
      }
      setCliApiKeys(result.records);
    } catch (error) {
      console.error('Failed to list CLI API keys:', error);
      toast.error(t('settings.account.cliAuth.loadFailed'), {
        description: t('common.tryAgain'),
      });
    } finally {
      setIsLoadingCliApiKeys(false);
    }
  }, [authBaseUrl, sessionToken, t]);

  useEffect(() => {
    void refreshCliApiKeys();
  }, [refreshCliApiKeys]);

  const handleInviteMember = async (
    email: string,
    inviteRole: 'member' | 'admin'
  ): Promise<Invitation | null> => {
    if (!activeOrganization) return null;

    try {
      const result = await authClient.organization.inviteMember({
        organizationId: activeOrganization.id,
        email,
        role: inviteRole,
      });

      if (result.data) {
        return result.data as Invitation;
      }
      if (result.error?.code === FREE_WORKSPACE_MEMBER_LIMIT_REACHED_CODE) {
        setMemberLimitReachedFromError(true);
        return null;
      }
      if (result.error) {
        throw new Error(result.error.message || 'Failed to create invitation');
      }
      return null;
    } catch (error) {
      console.error('Failed to invite member:', error);
      toast.error(t('workspace.invite.error'), {
        description: t('workspace.invite.errorDescription'),
      });
      return null;
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!activeOrganization) return;

    const memberToDelete = sortedMembers.find((member) => member.id === memberId);
    if (!memberToDelete) return;

    try {
      await authClient.organization.removeMember(
        buildOrganizationMemberRemovalRequest({
          organizationId: activeOrganization.id,
          member: memberToDelete,
        })
      );
      void refetchActiveOrganization();
    } catch (error) {
      console.error('Failed to remove member:', error);
      toast.error(t('workspace.removeMember.error', 'Failed to remove member'));
    }
  };

  const handleUpdateRole = async (
    member: OrganizationMemberRef,
    newRole: OrganizationMemberRole
  ) => {
    if (!activeOrganization) return;

    try {
      await authClient.organization.updateMemberRole(
        buildOrganizationMemberRoleUpdateRequest({
          organizationId: activeOrganization.id,
          member,
          role: newRole,
        })
      );

      void refetchActiveOrganization();
    } catch (error) {
      console.error('Failed to update member role:', error);
      toast.error(t('workspace.members.roleUpdateError'), {
        description: t('workspace.members.roleUpdateErrorDescription'),
      });
    }
  };

  const handleRenameOrganization = useCallback(
    async (name: string) => {
      if (!activeOrganization) return;

      try {
        await updateOrganization(activeOrganization.id, { name });
      } catch (error) {
        console.error('Failed to rename workspace:', error);
        throw error;
      }
    },
    [activeOrganization, updateOrganization]
  );

  // Load the user's linked OAuth + email/password accounts for the Profile
  // "Connected accounts" list. `credential` means an email/password login exists.
  useEffect(() => {
    if (!currentUserId) return undefined;
    let cancelled = false;
    setIsLoadingLinkedAccounts(true);
    void (async () => {
      try {
        const result = await authClient.listAccounts();
        if (cancelled) return;
        const accounts = Array.isArray(result?.data) ? result.data : [];
        setLinkedAccounts(
          accounts.map((account) => ({
            id: account.id,
            providerId: account.providerId,
            accountId: account.accountId,
            createdAt: account.createdAt ?? null,
          }))
        );
      } catch (error) {
        console.error('Failed to list linked accounts:', error);
      } finally {
        if (!cancelled) setIsLoadingLinkedAccounts(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authClient, currentUserId]);

  const hasPasswordCredential = useMemo(
    () => linkedAccounts.some((account) => account.providerId === 'credential'),
    [linkedAccounts]
  );

  const handleUpdateUserName = useCallback(
    async (name: string) => {
      const { error } = await authClient.updateUser({ name });
      if (error) {
        toast.error(t('settings.profile.nameUpdateError'), { description: error.message });
        throw new Error(error.message ?? 'Failed to update name');
      }
      void refetchSession();
    },
    [authClient, refetchSession, t]
  );

  const handleUploadAvatar = useCallback(
    async ({ kind, file }: { kind: AvatarKind; file: File }) => {
      if (!activeOrganizationId || !sessionToken) {
        throw new Error('not_authenticated');
      }
      const { url } = await uploadAvatarImage({
        workspaceId: activeOrganizationId as WorkspaceId,
        kind,
        token: sessionToken,
        file,
      });
      if (kind === 'user') {
        const { error } = await authClient.updateUser({ image: url });
        if (error) throw new Error(error.message ?? 'Failed to update avatar');
        void refetchSession();
      } else {
        await updateOrganization(activeOrganizationId, { logo: url });
      }
      return url;
    },
    [activeOrganizationId, authClient, refetchSession, sessionToken, updateOrganization]
  );

  const handleChangePassword = useCallback(
    async ({ currentPassword, newPassword }: { currentPassword: string; newPassword: string }) => {
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (error) {
        throw new Error(error.message ?? 'Failed to change password');
      }
      // Changing the password revokes other sessions; sign the user out so they
      // re-authenticate with the new credentials.
      await signOut();
    },
    [authClient, signOut]
  );

  // Verify the current password server-side before advancing the change-password
  // flow to the "new password" step.
  const handleVerifyCurrentPassword = useCallback(
    async (password: string) => {
      if (!sessionToken) {
        throw new Error('not_authenticated');
      }
      return await verifyCurrentPassword({ sessionToken, password });
    },
    [sessionToken]
  );

  // For OAuth-only accounts with no password: email a link to set one up.
  const handleSetupPassword = useCallback(async () => {
    const email = currentUser?.email;
    if (!email) {
      throw new Error('no_email');
    }
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: getAppShareUrl('/reset-password'),
    });
    if (error) {
      throw new Error(error.message ?? 'Failed to send email');
    }
  }, [authClient, currentUser?.email]);

  // Link a new OAuth provider to the current account (redirects to the provider).
  const handleConnectProvider = useCallback(
    async (providerId: string) => {
      const current = new URL(window.location.href);
      const callbackURL = `${current.pathname}${current.search}${current.hash}`;
      if (typeof authClient.linkSocial === 'function') {
        await authClient.linkSocial({ provider: providerId, callbackURL });
      } else {
        await authClient.signIn.social({ provider: providerId, callbackURL });
      }
    },
    [authClient]
  );

  const handleCancelInvitation = async (invitationId: string) => {
    try {
      const { error } = await authClient.organization.cancelInvitation({
        invitationId,
      });
      if (error) {
        throw error;
      }
    } catch (error) {
      console.error('Failed to cancel invitation:', error);
      toast.error(t('workspace.invitations.cancelError'));
      throw error;
    }
  };

  const handleCopyInviteLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
    } catch (error) {
      console.error('Failed to copy link:', error);
      toast.error(t('workspace.invite.linkCopyError', 'Failed to copy invite link'));
    }
  };

  const handleGenerateCliApiKey = useCallback(
    async (note: string) => {
      if (!authBaseUrl || !sessionToken) {
        toast.error(t('settings.account.cliAuth.generateFailed'), {
          description: 'not_authenticated',
        });
        return;
      }

      setIsCreatingCliApiKey(true);
      try {
        const result = await generateWebCliApiKey({ authBaseUrl, sessionToken, note });
        if (!result.ok) {
          toast.error(t('settings.account.cliAuth.generateFailed'), {
            description: result.error,
          });
          return;
        }

        setGeneratedCliApiKey(result.apiKey);
        const record = result.record;
        if (record) {
          setCliApiKeys((records) => [
            record,
            ...records.filter((existingRecord) => existingRecord.id !== record.id),
          ]);
        } else {
          void refreshCliApiKeys();
        }

        try {
          await navigator.clipboard.writeText(result.apiKey);
          toast.success(t('settings.account.cliAuth.generated'), {
            description: t('settings.account.cliAuth.copiedToClipboard'),
          });
        } catch (error) {
          console.error('Failed to copy generated CLI API key:', error);
          toast.success(t('settings.account.cliAuth.generated'), {
            description: t('settings.account.cliAuth.copyGeneratedFailed'),
          });
        }
      } catch (error) {
        console.error('Failed to generate CLI API key:', error);
        toast.error(t('settings.account.cliAuth.generateFailed'), {
          description: t('common.tryAgain'),
        });
      } finally {
        setIsCreatingCliApiKey(false);
      }
    },
    [authBaseUrl, refreshCliApiKeys, sessionToken, t]
  );

  const handleCopyGeneratedCliApiKey = useCallback(async () => {
    if (!generatedCliApiKey) return;

    try {
      await navigator.clipboard.writeText(generatedCliApiKey);
      toast.success(t('settings.account.cliAuth.copied'));
    } catch (error) {
      console.error('Failed to copy CLI API key:', error);
      toast.error(t('settings.account.cliAuth.copyFailed'));
    }
  }, [generatedCliApiKey, t]);

  const handleRevokeCliApiKey = useCallback(
    async (keyId: string) => {
      if (!authBaseUrl || !sessionToken) {
        toast.error(t('settings.account.cliAuth.revokeFailed'), {
          description: 'not_authenticated',
        });
        return;
      }

      setRevokingCliApiKeyId(keyId);
      try {
        const result = await revokeWebCliApiKey({ authBaseUrl, sessionToken, keyId });
        if (!result.ok) {
          toast.error(t('settings.account.cliAuth.revokeFailed'), {
            description: result.error,
          });
          return;
        }

        setCliApiKeys((records) => records.filter((record) => record.id !== keyId));
        toast.success(t('settings.account.cliAuth.revoked'));
      } catch (error) {
        console.error('Failed to revoke CLI API key:', error);
        toast.error(t('settings.account.cliAuth.revokeFailed'), {
          description: t('common.tryAgain'),
        });
      } finally {
        setRevokingCliApiKeyId(null);
      }
    },
    [authBaseUrl, sessionToken, t]
  );

  const handleLeaveOrganization = async () => {
    try {
      const slug = activeOrganization?.slug;
      if (activeOrganization) {
        await leaveOrganization(activeOrganization.id);
      }
      if (slug) clearPreferredWorkspaceSlugIfMatch(slug);
      void router.navigate({ to: '/' });
    } catch (error) {
      console.error('Failed to leave workspace:', error);
      toast.error(t('common.error'), {
        description: t('common.tryAgain'),
      });
    }
  };

  const handleDeleteOrganization = async () => {
    try {
      const slug = activeOrganization?.slug;
      if (activeOrganization) {
        await deleteOrganization(activeOrganization.id);
      }
      if (slug) clearPreferredWorkspaceSlugIfMatch(slug);
      void router.navigate({ to: '/' });
    } catch (error) {
      console.error('Failed to delete workspace:', error);
      toast.error(t('common.error'), {
        description: t('common.tryAgain'),
      });
    }
  };

  const handleDeleteAccount = useCallback(async () => {
    try {
      // Per product decision, deleting your account deletes every workspace you
      // own (including shared/team workspaces). Run the deletes in parallel.
      // `organization.delete` is best-effort: it is only permitted for
      // workspaces you own, so it fails harmlessly for workspaces where you are
      // a non-owner member (those memberships are cleared when `deleteUser`
      // removes your account below). A workspace that fails to delete must not
      // block account deletion — removing the account is the critical step — so
      // failures are logged, not thrown.
      const ownedOrgs = organizations ?? [];
      const orgResults = await Promise.allSettled(
        ownedOrgs.map((org) => authClient.organization.delete({ organizationId: org.id }))
      );
      orgResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.error(
            'Skipped workspace during account deletion:',
            ownedOrgs[index]?.id,
            result.reason
          );
        }
      });

      const { error } = await authClient.deleteUser({});
      if (error) {
        throw new Error(error.message || 'Failed to delete account');
      }

      // Account is gone; clear local auth state and return to the login screen.
      await signOut();
    } catch (error) {
      console.error('Failed to delete account:', error);
      toast.error(t('common.error'), {
        description: t('common.tryAgain'),
      });
      throw error;
    }
  }, [authClient, organizations, signOut, t]);

  if (orgLoading) {
    return (
      <AccountSettingsPure
        surface={surface}
        loading
        currentUser={currentUser}
        organization={{ id: '', name: '' }}
        role="member"
        hasAdminPermission={false}
        members={[]}
        pendingInvitations={[]}
        onSignOut={() => {
          void signOut();
        }}
        onInviteMember={handleInviteMember}
        onRemoveMember={handleRemoveMember}
        onUpdateRole={handleUpdateRole}
        onCopyInviteLink={handleCopyInviteLink}
        onCancelInvitation={handleCancelInvitation}
        onLeaveOrganization={handleLeaveOrganization}
        onDeleteOrganization={handleDeleteOrganization}
        onDeleteAccount={handleDeleteAccount}
        onRenameOrganization={handleRenameOrganization}
        getInviteLink={getInviteLink}
      />
    );
  }

  if (!activeOrganization) {
    return <p className="text-sm text-muted-foreground">No organization</p>;
  }

  return (
    <AccountSettingsPure
      surface={surface}
      currentUser={currentUser}
      organization={activeOrganization}
      role={role as 'owner' | 'admin' | 'member'}
      hasAdminPermission={hasAdminPermission}
      members={sortedMembers}
      pendingInvitations={pendingInvitations}
      accountMachinesSlot={surface === 'account' ? <AccountMachinesOverview /> : undefined}
      workspaceJoinRequestsSlot={
        role === 'owner' ? (
          <WorkspaceJoinRequestsSettings workspaceId={activeOrganization.id} />
        ) : undefined
      }
      memberLimit={memberLimitState?.memberLimit ?? null}
      memberLimitReached={memberLimitReachedFromError || memberLimitState?.canInvite === false}
      billingUiAvailable={billingUiAvailable}
      onSignOut={() => {
        void signOut();
      }}
      onInviteMember={handleInviteMember}
      onRemoveMember={handleRemoveMember}
      onUpdateRole={handleUpdateRole}
      onCopyInviteLink={handleCopyInviteLink}
      onCancelInvitation={handleCancelInvitation}
      onLeaveOrganization={handleLeaveOrganization}
      onDeleteOrganization={handleDeleteOrganization}
      deleteBillingGuard={deleteBillingGuard}
      onDeleteAccount={handleDeleteAccount}
      onRenameOrganization={handleRenameOrganization}
      onOpenBilling={
        billingUiAvailable
          ? () => {
              if (!activeOrganization.slug) return;
              void router.navigate({
                to: '/$workspaceName/settings/billing',
                params: { workspaceName: activeOrganization.slug },
              });
            }
          : undefined
      }
      getInviteLink={getInviteLink}
      onUpdateUserName={handleUpdateUserName}
      onUploadAvatar={handleUploadAvatar}
      linkedAccounts={linkedAccounts}
      isLoadingLinkedAccounts={isLoadingLinkedAccounts}
      onConnectAccount={canLinkOAuthAccounts ? handleConnectProvider : undefined}
      showLinkedAccounts={canLinkOAuthAccounts}
      hasPasswordCredential={hasPasswordCredential}
      onChangePassword={handleChangePassword}
      onVerifyCurrentPassword={handleVerifyCurrentPassword}
      onSetupPassword={handleSetupPassword}
      canGenerateCliApiKey={canGenerateCliApiKey}
      cliApiKeys={cliApiKeys}
      isLoadingCliApiKeys={isLoadingCliApiKeys}
      isCreatingCliApiKey={isCreatingCliApiKey}
      hasGeneratedCliApiKey={Boolean(generatedCliApiKey)}
      onGenerateCliApiKey={handleGenerateCliApiKey}
      onCopyGeneratedCliApiKey={handleCopyGeneratedCliApiKey}
      onClearGeneratedCliApiKey={() => setGeneratedCliApiKey(null)}
      onRevokeCliApiKey={handleRevokeCliApiKey}
      revokingCliApiKeyId={revokingCliApiKeyId}
    />
  );
}
