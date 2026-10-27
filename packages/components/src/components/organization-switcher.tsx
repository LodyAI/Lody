import { useMemo, useState } from 'react';
import { ChevronsUpDown, Plus, Building2, LogOut } from 'lucide-react';
import {
  EncryptedWorkspaceMark,
  isListedEncryptedWorkspace,
} from '@/components/e2ee/encrypted-workspace-mark';
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
import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../style/theme-scale.stylex';

const styles = stylex.create({
  /** A row that says the workspace is still loading. */
  loadingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
  },
  buildingIcon: {
    width: themeSpace[4],
    height: themeSpace[4],
    color: themeColors.mutedForeground,
  },
  loadingText: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  /** The local build's nameplate: the workspace's name and nothing else. */
  nameplateRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[3],
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
  },
  nameplateName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: themeFontSize.lg,
    lineHeight: themeLineHeight.lg,
    fontWeight: themeFontWeight.semibold,
  },
  /** The switcher row: the trigger fills it. */
  switcherRow: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1],
    width: '100%',
  },
  triggerContent: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[3],
  },
  nameColumn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  workspaceName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '120px',
    fontSize: themeFontSize.lg,
    lineHeight: themeLineHeight.lg,
    fontWeight: themeFontWeight.semibold,
  },
  statusSlot: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1],
    paddingInlineStart: themeSpace[2],
  },
  statusDot: {
    width: themeSpace[2],
    height: themeSpace[2],
    borderRadius: themeRadius.full,
    backgroundColor: themeColors.statusDanger,
  },
  chevron: {
    marginLeft: themeSpace[2],
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    opacity: 0.5,
  },
  /** The create form: the two fields, one step apart. */
  formStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[4],
    paddingBlock: themeSpace[4],
  },
  fieldStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[2],
  },
  fieldHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  resetButton: {
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: { default: themeColors.mutedForeground, ':hover': themeColors.foreground },
  },
  errorText: {
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.destructive,
  },
  statusText: {
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
});

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
      <div {...stylex.props(styles.loadingRow)}>
        <Building2 {...stylex.props(styles.buildingIcon)} />
        <span {...stylex.props(styles.loadingText)}>{t('common.loading')}</span>
      </div>
    );
  }

  return (
    <div {...stylex.props(styles.nameplateRow)}>
      <WorkspaceAvatar
        workspace={{ name: workspace.name, logo: resolveWorkspaceIdentityLogo(null, false) }}
        size="large"
      />
      <span {...stylex.props(styles.nameplateName)}>{workspace.name}</span>
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
      <div {...stylex.props(styles.loadingRow)}>
        <Building2 {...stylex.props(styles.buildingIcon)} />
        <span {...stylex.props(styles.loadingText)}>
          {loading ? t('common.loading') : t('organization.noOrganization')}
        </span>
      </div>
    );
  }

  return (
    <>
      <div {...stylex.props(styles.switcherRow)}>
        <Menu.Root modal={!isMobile} open={open} onOpenChange={setOpen}>
          <Menu.Trigger
            render={
              <Button variant="ghost" className="flex-1 justify-between" disabled={loading}>
                <div {...stylex.props(styles.triggerContent)}>
                  <WorkspaceAvatar
                    workspace={{
                      name: activeOrganization.name,
                      logo: activeOrganization.logo,
                    }}
                    size="large"
                  />
                  <div {...stylex.props(styles.nameColumn)}>
                    <span {...stylex.props(styles.workspaceName)}>{activeOrganization.name}</span>
                  </div>
                  <div {...stylex.props(styles.statusSlot)}>
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
                        render={<div {...stylex.props(styles.statusDot)} />}
                      />
                      <Tooltip.Content>{t('common.disconnected')}</Tooltip.Content>
                    </Tooltip.Root>
                  </div>
                </div>

                <ChevronsUpDown {...stylex.props(styles.chevron)} />
              </Button>
            }
          >
            <Button variant="ghost" className="flex-1 justify-between" disabled={loading}>
              <div {...stylex.props(styles.triggerContent)}>
                <WorkspaceAvatar
                  workspace={{
                    name: activeOrganization.name,
                    logo: activeOrganization.logo,
                  }}
                  size="large"
                />
                <div {...stylex.props(styles.nameColumn)}>
                  <span {...stylex.props(styles.workspaceName)}>{activeOrganization.name}</span>
                </div>
                <div {...stylex.props(styles.statusSlot)}>
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
                      render={<div {...stylex.props(styles.statusDot)} />}
                    />
                    <Tooltip.Content>{t('common.disconnected')}</Tooltip.Content>
                  </Tooltip.Root>
                </div>
              </div>

              <ChevronsUpDown {...stylex.props(styles.chevron)} />
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
                  {isListedEncryptedWorkspace(org) ? <EncryptedWorkspaceMark /> : null}
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
          <div {...stylex.props(styles.formStack)}>
            <div {...stylex.props(styles.fieldStack)}>
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
            <div {...stylex.props(styles.fieldStack)}>
              <div {...stylex.props(styles.fieldHead)}>
                <UiField.Label htmlFor="slug">{t('organization.workspaceSlug')}</UiField.Label>
                {canResetNewOrgSlug && (
                  <button
                    type="button"
                    {...stylex.props(styles.resetButton)}
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
                <p {...stylex.props(styles.errorText)}>
                  {t(`organization.workspaceSlugError.${newOrgSlugError}`)}
                </p>
              )}
              {newOrgSlug && !newOrgSlugError && (
                <p {...stylex.props(styles.statusText)}>
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
