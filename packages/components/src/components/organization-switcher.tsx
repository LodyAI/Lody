import { useMemo, useState } from 'react';
import { ChevronsUpDown, Plus, Building2, LogOut } from 'lucide-react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useCloudQuery } from '@lody/platform/react';
import { useOrganization } from '../hooks/useOrganization';
import { useWorkspaceSlugField } from '../hooks/useWorkspaceSlugField';
import { useTranslation } from 'react-i18next';
import { Menu } from '@/ui/menu';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { Input } from '@lody/ui/input';
import { Field as UiField } from '@lody/ui/field';
import { Tooltip } from '@lody/ui/tooltip';
import { useNavigate } from '@tanstack/react-router';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAuthSignOut } from '../providers/convex-provider';
import { useImplicitLocalWorkspace } from '../providers/local-platform-provider';
import { useAppCapability } from '@/lib/app-platform';
import { WorkspaceAvatar } from './workspace-avatar';
import { resolveWorkspaceIdentityLogo } from '@/lib/workspace-identity';

/**
 * 组织切换器组件
 * 显示当前组织，支持切换和创建新组织
 */
export function OrganizationSwitcher() {
  // Without 'multiWorkspace' (open-source local build) there is exactly one
  // implicit workspace: render its name without switcher / create / sign-out
  // affordances.
  const multiWorkspaceAvailable = useAppCapability('multiWorkspace');
  if (!multiWorkspaceAvailable) {
    return <LocalWorkspaceNameplate />;
  }
  return <CloudOrganizationSwitcher />;
}

function LocalWorkspaceNameplate() {
  const { t } = useTranslation();
  const workspace = useImplicitLocalWorkspace();

  if (!workspace) {
    return (
      <div className="flex items-center gap-2 px-3 py-2">
        <Building2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t('common.loading')}</span>
      </div>
    );
  }

  return (
    <div className="flex w-full items-center gap-3 px-3 py-2">
      <WorkspaceAvatar
        workspace={{ name: workspace.name, logo: resolveWorkspaceIdentityLogo(null, false) }}
        size="large"
      />
      <span className="truncate text-lg font-semibold">{workspace.name}</span>
    </div>
  );
}

function CloudOrganizationSwitcher() {
  const { t } = useTranslation();
  const signOut = useAuthSignOut();
  const { activeOrganization, organizations, loading, switchOrganization, createOrganization } =
    useOrganization();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  // Paid workspaces only (free ones are omitted by the query); keyed by the
  // better-auth organization id, which is what billing uses as workspaceId.
  const paidPlanTiers = useCloudQuery(cloudOperations.billing.getMyPaidWorkspacePlanTiers, {});
  const planTierByWorkspaceId = useMemo(
    () => new Map((paidPlanTiers ?? []).map((entry) => [entry.workspaceId, entry.planTier])),
    [paidPlanTiers]
  );

  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [creating, setCreating] = useState(false);
  const {
    slug: newOrgSlug,
    setSlug: setNewOrgSlug,
    resetSlug: resetNewOrgSlug,
    canReset: canResetNewOrgSlug,
    isChecking: newOrgSlugChecking,
    isAvailable: newOrgSlugAvailable,
    error: newOrgSlugError,
  } = useWorkspaceSlugField(newOrgName);

  /**
   * 处理创建新组织
   */
  const handleCreateOrganization = async () => {
    if (!newOrgName.trim()) return;
    if (newOrgSlugError || newOrgSlugChecking || !newOrgSlugAvailable || !newOrgSlug) {
      return;
    }

    setCreating(true);
    try {
      const draftSlug = newOrgSlug;
      const createdOrganization = await createOrganization(newOrgName.trim(), draftSlug);
      setDialogOpen(false);
      setNewOrgName('');
      resetNewOrgSlug();
      const targetSlug = createdOrganization?.slug || draftSlug;
      if (targetSlug) {
        void navigate({
          to: '/$workspaceName/chat',
          params: { workspaceName: targetSlug },
        });
      }
    } catch (error) {
      console.error('Failed to create organization:', error);
    } finally {
      setCreating(false);
    }
  };

  if (!activeOrganization || !organizations) {
    return (
      <div className="flex items-center gap-2 px-3 py-2">
        <Building2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">
          {loading ? t('common.loading') : t('organization.noOrganization')}
        </span>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-1 w-full">
        <Menu.Root modal={!isMobile} open={open} onOpenChange={setOpen}>
          <Menu.Trigger
            render={
              <Button variant="ghost" className="flex-1 justify-between" disabled={loading}>
                <div className="flex items-center gap-3">
                  <WorkspaceAvatar
                    workspace={{
                      name: activeOrganization.name,
                      logo: activeOrganization.logo,
                    }}
                    size="large"
                  />
                  <div className="flex flex-col items-start">
                    <span className="text-lg font-semibold truncate max-w-[120px]">
                      {activeOrganization.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 pl-2">
                    {/* {loroConnect ? (
                    <Tooltip.Root>
                      <Tooltip.Trigger delay={500} render={<div className="h-2 w-2 rounded-full bg-status-success" />}/>
                      <Tooltip.Content>{t('common.connected')}</Tooltip.Content>
                    </Tooltip.Root>
                  ) :  */}
                    {/*  TODO:  ws state */}
                    <Tooltip.Root>
                      <Tooltip.Trigger
                        delay={500}
                        render={<div className="h-2 w-2 rounded-full bg-status-danger" />}
                      />
                      <Tooltip.Content>{t('common.disconnected')}</Tooltip.Content>
                    </Tooltip.Root>
                  </div>
                </div>

                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            }
          >
            <Button variant="ghost" className="flex-1 justify-between" disabled={loading}>
              <div className="flex items-center gap-3">
                <WorkspaceAvatar
                  workspace={{
                    name: activeOrganization.name,
                    logo: activeOrganization.logo,
                  }}
                  size="large"
                />
                <div className="flex flex-col items-start">
                  <span className="text-lg font-semibold truncate max-w-[120px]">
                    {activeOrganization.name}
                  </span>
                </div>
                <div className="flex items-center gap-1 pl-2">
                  {/* {loroConnect ? (
                    <Tooltip.Root>
                      <Tooltip.Trigger delay={500} render={<div className="h-2 w-2 rounded-full bg-status-success" />}/>
                      <Tooltip.Content>{t('common.connected')}</Tooltip.Content>
                    </Tooltip.Root>
                  ) :  */}
                  {/*  TODO:  ws state */}
                  <Tooltip.Root>
                    <Tooltip.Trigger
                      delay={500}
                      render={<div className="h-2 w-2 rounded-full bg-status-danger" />}
                    />
                    <Tooltip.Content>{t('common.disconnected')}</Tooltip.Content>
                  </Tooltip.Root>
                </div>
              </div>

              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </Menu.Trigger>
          <Menu.Content align="start" className="w-[250px]">
            <Menu.GroupLabel>{t('organization.workspaces')}</Menu.GroupLabel>
            <Menu.Separator />
            <Menu.RadioGroup
              value={activeOrganization.id}
              onValueChange={(orgId) => {
                const org = organizations.find((candidate) => candidate.id === orgId);
                if (!org) return;
                void switchOrganization(org.id);
                setOpen(false);
                if (org.slug) {
                  void navigate({
                    to: '/$workspaceName/chat',
                    params: { workspaceName: org.slug },
                  });
                }
              }}
            >
              {organizations.map((org) => (
                <Menu.RadioItem key={org.id} value={org.id} indicator="check" indicatorSide="end">
                  <WorkspaceAvatar
                    workspace={{ name: org.name, logo: org.logo }}
                    size="medium"
                    className="shrink-0"
                  />
                  {org.name}
                  {planTierByWorkspaceId.has(org.id) ? (
                    <Badge>
                      {planTierByWorkspaceId.get(org.id) === 'enterprise'
                        ? t('billing.plan.enterprise')
                        : t('billing.plan.plus')}
                    </Badge>
                  ) : null}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
            <Menu.Item
              icon={Plus}
              onClick={() => {
                setDialogOpen(true);
                setOpen(false);
              }}
            >
              {t('organization.createNew')}
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item
              tone="destructive"
              icon={LogOut}
              onClick={() => {
                void signOut();
              }}
            >
              {t('organization.signOut')}
            </Menu.Item>
          </Menu.Content>
        </Menu.Root>
      </div>

      <Dialog.Root
        open={dialogOpen}
        onOpenChange={(nextOpen) => {
          setDialogOpen(nextOpen);
          if (!nextOpen) {
            setNewOrgName('');
            resetNewOrgSlug();
          }
        }}
      >
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>{t('organization.createNewWorkspace')}</Dialog.Title>
            <Dialog.Description>
              {t('organization.createNewWorkspaceDescription')}
            </Dialog.Description>
          </Dialog.Header>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <UiField.Label htmlFor="name">{t('organization.workspaceName')}</UiField.Label>
              <Input
                id="name"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                placeholder={t('organization.workspaceNamePlaceholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !creating) {
                    void handleCreateOrganization();
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <UiField.Label htmlFor="slug">{t('organization.workspaceSlug')}</UiField.Label>
                {canResetNewOrgSlug && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={resetNewOrgSlug}
                    disabled={creating}
                  >
                    {t('organization.workspaceSlugReset')}
                  </button>
                )}
              </div>
              <Input
                id="slug"
                value={newOrgSlug}
                onChange={(e) => setNewOrgSlug(e.target.value)}
                placeholder={t('organization.workspaceSlugPlaceholder', 'my-workspace')}
                className={newOrgSlugError ? 'border-destructive' : ''}
                disabled={creating}
              />
              {newOrgSlugError && (
                <p className="text-xs text-destructive">
                  {t(`organization.workspaceSlugError.${newOrgSlugError}`)}
                </p>
              )}
              {newOrgSlug && !newOrgSlugError && (
                <p className="text-xs text-muted-foreground">
                  {newOrgSlugChecking
                    ? t('organization.workspaceSlugChecking')
                    : newOrgSlugAvailable
                      ? t('organization.workspaceSlugAvailable')
                      : null}
                </p>
              )}
            </div>
          </div>
          <Dialog.Footer>
            <Button variant="secondary" onClick={() => setDialogOpen(false)} disabled={creating}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                void handleCreateOrganization();
              }}
              disabled={
                !newOrgName.trim() ||
                creating ||
                newOrgSlugChecking ||
                Boolean(newOrgSlugError) ||
                !newOrgSlugAvailable
              }
            >
              {creating ? t('common.creating') : t('common.create')}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
