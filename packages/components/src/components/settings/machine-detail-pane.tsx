import { useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import {
  type AcpSessionMonitorSnapshot,
  type AgentConfigMeta,
  type MachineId,
  type MachineMonitorSnapshot,
  type MachineViewMeta,
  type ProviderSetupTask,
  type SessionMeta,
} from '@lody/shared';
import {
  Activity,
  Bot,
  ChevronUp,
  Download,
  Laptop,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Unplug,
  UserRound,
  Users,
} from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Switch } from '@lody/ui/switch';
import { Menu } from '@/ui/menu';
import { AlertDialog } from '@/ui/dialog';
import { Tooltip } from '@lody/ui/tooltip';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space } from '@lody/ui/tokens/scales.stylex';
import { useIsMobile } from '@/hooks/use-mobile';
import { useMachineOnlineStatus } from '@/hooks/use-machine-online-status';
import { useMachineActionState } from '@/hooks/use-machine-action-state';
import { MobileSettingsDetailHeader } from '@/components/mobile/mobile-settings-layout';
import { MobileSettingsSection } from '@/components/mobile/mobile-settings-row';
import { ProviderRow } from './provider-row';
import { ProviderSetupRow } from './provider-setup-row';
import { DeviceResourceMonitor } from './device-resource-monitor';
import { CompactSection } from './compact-layout';
import { settingsSurface as surface } from './surface';
import type { MachineMonitorViewState } from '@/hooks/use-machine-monitor';
import {
  WorkspaceMachineAccordionSummary,
  WorkspaceMachineOwnerAvatar,
  type WorkspaceMachineAccordionMeta,
} from './workspace-machine-accordion';

const MONO = 'var(--font-mono, ui-monospace, monospace)';

const styles = stylex.create({
  icon12: { width: '12px', height: '12px', flexShrink: 0 },
  icon14: { width: '14px', height: '14px', flexShrink: 0 },
  /** A glyph in a box that sizes it — a menu row's leading box, a badge's. */
  iconFill: { width: '100%', height: '100%' },
  mono: { fontFamily: MONO },
  /** The section's card sits in from the pane's edge unless the caller is already inset. */
  inset: { paddingInline: space[4] },
  /** One line of a list: every line but the first is ruled from the one above. */
  line: { minWidth: 0 },
  lineRuled: { boxShadow: `inset 0 1px 0 ${colors.separator}` },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space[3],
    paddingInline: space[6],
    paddingBlock: space[8],
    textAlign: 'center',
  },
  emptyIcon: { width: '24px', height: '24px', color: colors.tertiaryLabel },
  emptyCopy: { margin: 0, fontSize: '0.875em', color: colors.secondaryLabel },
  pane: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    minWidth: 0,
    minHeight: 0,
    height: '100%',
  },
  paneInAccordion: { height: 'auto' },
  header: { paddingInline: space[4], paddingBlock: space[3] },
  headerCompact: { paddingBlock: space[2] },
  /**
   * The accordion's own header stays in view while its body scrolls. It is the
   * card's top, so it takes the card's fill and no rule under it.
   */
  headerSticky: {
    position: 'sticky',
    top: 0,
    zIndex: 20,
    backgroundColor: colors.elevatedBackground,
    borderStartStartRadius: radius.large,
    borderStartEndRadius: radius.large,
    cornerShape: corner.shape,
  },
  toolbar: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  statusDot: {
    flexShrink: 0,
    width: '10px',
    height: '10px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.tertiaryLabel,
  },
  statusDotSmall: { width: '8px', height: '8px', marginInline: space[1] },
  statusDotOnline: {
    backgroundColor: colors.success,
    boxShadow: `0 0 0 4px color-mix(in oklab, ${colors.success} 20%, transparent)`,
  },
  titleGroup: { display: 'contents' },
  titleGroupMobile: {
    display: 'flex',
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 0,
  },
  renameInput: { flexGrow: 1 },
  title: {
    minWidth: 0,
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '1em',
    fontWeight: 400,
    color: colors.label,
  },
  titleMobile: { fontSize: '1.125em', textAlign: 'center' },
  ping: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: space[1.5] },
  pushEnd: { marginInlineStart: 'auto' },
  latency: { fontFamily: MONO, fontSize: '0.75em', color: colors.secondaryLabel },
  share: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[2],
    marginInlineStart: 'auto',
    paddingInlineStart: space[2],
  },
  shareLabel: { whiteSpace: 'nowrap', fontSize: '0.75em', color: colors.secondaryLabel },
  /** Between the management actions and the destructive ones: one structural line. */
  groupRule: {
    flexShrink: 0,
    width: '1px',
    height: '16px',
    marginInline: '2px',
    backgroundColor: colors.separator,
  },
  /** Keeps the tooltip reachable over a disabled button, which takes no pointer. */
  tooltipAnchor: { display: 'inline-flex', flexShrink: 0 },
  switchInMenu: { pointerEvents: 'none' },
  metaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
    marginTop: space[1.5],
  },
  metaRowMobile: {
    marginTop: 0,
    paddingInline: space[4],
    paddingBlock: space[1],
  },
  summaryRow: { display: 'flex', marginTop: space[1.5] },
  update: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    marginTop: space[3],
  },
  updateText: { minWidth: 0 },
  updateTitle: { fontSize: '0.75em', color: colors.label },
  updateVersion: { fontFamily: MONO, fontSize: '0.7em', color: colors.secondaryLabel },
  body: { flexGrow: 1, minHeight: 0, overflowY: 'auto' },
  bodyInAccordion: { overflowY: 'visible' },
});

export type MachineProvidersSectionProps = {
  machine: MachineViewMeta;
  configs: AgentConfigMeta[];
  setups?: ProviderSetupTask[];
  onAddConfig: () => void;
  onEditConfig: (config: AgentConfigMeta) => void;
  onDeleteConfig?: (config: AgentConfigMeta) => Promise<void>;
  onRefreshConfig?: (config: AgentConfigMeta) => Promise<void>;
  onRetrySetup?: (setup: ProviderSetupTask) => Promise<void>;
  onDeleteSetup?: (setup: ProviderSetupTask) => Promise<void>;
  /** Desktop pills content is flush with the title — no extra horizontal inset. */
  flush?: boolean;
  variant?: 'default' | 'mobile-list';
};

/** "Agent Provider" list + add button — shared by the mobile detail pane and the
 *  desktop Agents tab. */
export function MachineProvidersSection({
  machine,
  configs,
  setups = [],
  onAddConfig,
  onEditConfig,
  onDeleteConfig,
  onRefreshConfig,
  onRetrySetup,
  onDeleteSetup,
  flush = false,
  variant = 'default',
}: MachineProvidersSectionProps) {
  const { t } = useTranslation();
  const addButton = (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <Button
            variant="ghost"
            size="small"
            icon
            onClick={onAddConfig}
            aria-label={t('settings.agent.provider.addProvider', 'Add provider')}
          >
            <Plus {...stylex.props(styles.icon14)} />
          </Button>
        }
      />
      <Tooltip.Content>{t('settings.agent.provider.addProvider', 'Add provider')}</Tooltip.Content>
    </Tooltip.Root>
  );

  const providerLines = [
    ...setups.map((setup) => (
      <ProviderSetupRow
        key={setup.id}
        setup={setup}
        machine={machine}
        onRetry={onRetrySetup ?? (async () => undefined)}
        onDelete={onDeleteSetup ?? (async () => undefined)}
      />
    )),
    ...configs.map((config) => (
      <ProviderRow
        key={config.id}
        config={config}
        machine={machine}
        onEdit={onEditConfig}
        onDelete={onDeleteConfig}
        onRefresh={onRefreshConfig}
        variant="list"
      />
    )),
  ];

  if (variant === 'mobile-list') {
    return (
      <MobileSettingsSection
        title={t('settings.agent.provider.title', 'Agent Provider')}
        actions={addButton}
      >
        {configs.length === 0 && setups.length === 0 ? (
          <EmptyProviders onAdd={onAddConfig} />
        ) : (
          providerLines.map((line, index) => (
            <div key={line.key} {...stylex.props(styles.line, index > 0 && styles.lineRuled)}>
              {line}
            </div>
          ))
        )}
      </MobileSettingsSection>
    );
  }

  // The providers are one list, so one card of ruled rows: the section rules
  // the lines between them, and a provider is a row of it, not a card.
  return (
    <div {...stylex.props(!flush && styles.inset)}>
      <CompactSection
        title={t('settings.agent.provider.title', 'Agent Provider')}
        actions={addButton}
      >
        {configs.length === 0 && setups.length === 0 ? (
          <EmptyProviders onAdd={onAddConfig} />
        ) : (
          providerLines
        )}
      </CompactSection>
    </div>
  );
}

export type MachineDetailPaneProps = {
  mode?: 'agents' | 'devices';
  readOnly?: boolean;
  machine: MachineViewMeta;
  configs: AgentConfigMeta[];
  setups?: ProviderSetupTask[];
  isOwn: boolean;
  isLocal: boolean;
  ownerName: string | null;
  sharedWithTeam: boolean;
  canDelete: boolean;
  onRename: (machineId: MachineId, newName: string) => Promise<void>;
  onDelete: (machine: MachineViewMeta) => Promise<void>;
  onSharedWithTeamChange?: (machineId: MachineId, sharedWithTeam: boolean) => Promise<void>;
  onAddConfig: () => void;
  onEditConfig: (config: AgentConfigMeta) => void;
  onDeleteConfig?: (config: AgentConfigMeta) => Promise<void>;
  onRefreshConfig?: (config: AgentConfigMeta) => Promise<void>;
  onRetrySetup?: (setup: ProviderSetupTask) => Promise<void>;
  onDeleteSetup?: (setup: ProviderSetupTask) => Promise<void>;
  onPing?: (machineId: MachineId) => Promise<number>;
  daemonUpdate?: { currentVersion: string; latestVersion: string };
  onRestartDaemon?: (machineId: MachineId) => Promise<void>;
  onUpgradeDaemon?: (machineId: MachineId, targetVersion: string) => Promise<void>;
  canRevokeCredentials?: boolean;
  /** Must reject on failure so the confirm dialog stays open; the callback owns
   *  surfacing the error (toast) exactly once. */
  onRevokeCredentials?: () => Promise<void>;
  monitorSnapshot?: MachineMonitorSnapshot | null;
  monitorState?: MachineMonitorViewState;
  monitorSessionMetas?: readonly SessionMeta[];
  onOpenMonitorSession?: (session: AcpSessionMonitorSnapshot, meta?: SessionMeta) => void;
  onTerminateMonitorSession?: (session: AcpSessionMonitorSnapshot) => Promise<void>;
  /** Extra owner-only information shown below the resource monitor. */
  footer?: ReactNode;
  /** Desktop Machines embeds the detail directly below its full-width accordion row. */
  accordion?: {
    meta: WorkspaceMachineAccordionMeta;
    onCollapse: () => void;
    /** The accordion list owns the stable summary row and mounts this pane as its body. */
    headerRenderedExternally?: boolean;
  };
};

export function MachineDetailPane(props: MachineDetailPaneProps) {
  const {
    machine,
    mode = 'agents',
    readOnly = false,
    configs,
    setups = [],
    isOwn,
    isLocal,
    ownerName,
    sharedWithTeam,
    canDelete,
    onRename,
    onDelete,
    onSharedWithTeamChange,
    onAddConfig,
    onEditConfig,
    onDeleteConfig,
    onRefreshConfig,
    onRetrySetup,
    onDeleteSetup,
    onPing,
    daemonUpdate,
    onRestartDaemon,
    onUpgradeDaemon,
    canRevokeCredentials = false,
    onRevokeCredentials,
    monitorSnapshot = null,
    monitorState = 'disabled',
    monitorSessionMetas = [],
    onOpenMonitorSession,
    onTerminateMonitorSession,
    footer,
    accordion,
  } = props;
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const monitoredOnline = useMachineOnlineStatus(machine.id) === 'online';
  // The accordion list already owns the workspace-wide presence snapshot. Reuse
  // it so collapsing and expanding a row cannot briefly change the status dot.
  const isOnline = accordion ? accordion.meta.isOnline : monitoredOnline;

  const {
    renaming,
    setRenaming,
    renameDraft,
    setRenameDraft,
    renameSaving,
    inputRef,
    commitRename,
    sharing,
    effectiveShared,
    handleSharedToggle,
    deleteOpen,
    setDeleteOpen,
    deleting,
    handleDelete,
    pinging,
    pingLatencyMs,
    handlePing,
    restartingDaemon,
    upgradingDaemon,
    handleRestartDaemon,
    handleUpgradeDaemon,
  } = useMachineActionState({
    machine,
    sharedWithTeam,
    daemonUpdate,
    onRename,
    onDelete,
    onSharedWithTeamChange,
    onPing,
    onRestartDaemon,
    onUpgradeDaemon,
  });
  const pendingRenameRef = useRef(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const manageableOwnMachine = isOwn && !readOnly;
  const shareControlVisible =
    !isMobile && !renaming && manageableOwnMachine && !!onSharedWithTeamChange;
  const restartVisible = !isMobile && !renaming && !readOnly && !!onRestartDaemon;
  const revokeVisible =
    !isMobile && !renaming && !readOnly && canRevokeCredentials && !!onRevokeCredentials;
  const removeVisible = !isMobile && !renaming && manageableOwnMachine;
  const managementGroupVisible =
    shareControlVisible || restartVisible || (!isMobile && !renaming && !!onPing);
  const destructiveGroupVisible = revokeVisible || removeVisible;
  const updateVisible = isOnline && !!daemonUpdate && !!onUpgradeDaemon;
  // Desktop renders every action inline in the header (rename pencil, share
  // switch, ping, restart, revoke, delete); the ⋮ menu is mobile-only.
  const actionsMenuVisible =
    !renaming &&
    isMobile &&
    !readOnly &&
    (isOwn || canDelete || !!onRestartDaemon || !!onPing || (updateVisible && !!daemonUpdate));
  const externalAccordionHeader = accordion?.headerRenderedExternally === true;
  const detailToolbarVisible =
    !externalAccordionHeader ||
    manageableOwnMachine ||
    !!onPing ||
    shareControlVisible ||
    restartVisible ||
    destructiveGroupVisible ||
    updateVisible;

  const metaBadges = (
    <>
      {isLocal && <Badge>{t('workspace.machines.thisDevice', 'This device')}</Badge>}
      {ownerName && !isOwn && (
        <Badge icon={<UserRound {...stylex.props(styles.iconFill)} />}>{ownerName}</Badge>
      )}
      {isMobile && (
        <span
          aria-hidden
          {...stylex.props(
            styles.statusDot,
            styles.statusDotSmall,
            isOnline && styles.statusDotOnline
          )}
        />
      )}
      <Badge icon={<Laptop {...stylex.props(styles.iconFill)} />}>{machine.os || '-'}</Badge>
      <Badge>
        <span {...stylex.props(styles.mono)}>
          {machine.cliVersion ? `v${machine.cliVersion}` : t('machines.never', 'Never')}
        </span>
      </Badge>
    </>
  );

  return (
    <div {...stylex.props(styles.pane, accordion && styles.paneInAccordion)}>
      {detailToolbarVisible ? (
        <header
          {...stylex.props(
            styles.header,
            externalAccordionHeader && styles.headerCompact,
            accordion && !externalAccordionHeader && styles.headerSticky
          )}
        >
          <MobileSettingsDetailHeader active={isMobile}>
            <div {...stylex.props(styles.toolbar)}>
              {accordion && !externalAccordionHeader ? (
                <span
                  role="img"
                  aria-label={
                    isOnline
                      ? t('workspace.machines.online', 'Online')
                      : t('workspace.machines.offline', 'Offline')
                  }
                  {...stylex.props(styles.statusDot, isOnline && styles.statusDotOnline)}
                />
              ) : null}
              <div {...stylex.props(isMobile ? styles.titleGroupMobile : styles.titleGroup)}>
                {renaming ? (
                  <Input
                    ref={inputRef}
                    value={renameDraft}
                    disabled={renameSaving}
                    size="small"
                    className={stylex.props(styles.renameInput).className}
                    onChange={(event) =>
                      setRenameDraft(event.target.value.replace(/[\r\n]+/g, ' '))
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setRenameDraft(machine.name);
                        setRenaming(false);
                        return;
                      }
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                    onBlur={() => void commitRename()}
                  />
                ) : externalAccordionHeader ? (
                  manageableOwnMachine ? (
                    <Button variant="ghost" size="small" onClick={() => setRenaming(true)}>
                      <Pencil {...stylex.props(styles.icon12)} />
                      {t('workspace.machines.editName', 'Edit machine name')}
                    </Button>
                  ) : null
                ) : (
                  <>
                    <h2 {...stylex.props(styles.title, isMobile && styles.titleMobile)}>
                      {machine.name || machine.id}
                    </h2>
                    {renameSaving && <Spinner size="small" />}
                    {!isMobile && manageableOwnMachine && (
                      <Button
                        variant="ghost"
                        size="mini"
                        icon
                        aria-label={t('workspace.machines.editName', 'Edit machine name')}
                        onClick={() => setRenaming(true)}
                      >
                        <Pencil {...stylex.props(styles.iconFill)} />
                      </Button>
                    )}
                  </>
                )}
              </div>
              {onPing && !renaming && !isMobile && (
                <div {...stylex.props(styles.ping, !shareControlVisible && styles.pushEnd)}>
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={pinging}
                    onClick={() => void handlePing()}
                  >
                    {pinging ? (
                      <Spinner size="small" />
                    ) : (
                      <Activity {...stylex.props(styles.icon14)} />
                    )}
                    {t('settings.agent.machinePing.button', 'Ping')}
                  </Button>
                  {pingLatencyMs !== null && (
                    <span {...stylex.props(styles.latency)}>
                      {t('settings.agent.machinePing.latency', '{{latency}} ms', {
                        latency: String(pingLatencyMs),
                      })}
                    </span>
                  )}
                </div>
              )}
              {shareControlVisible && (
                <div {...stylex.props(styles.share)}>
                  <span {...stylex.props(styles.shareLabel)}>
                    {t('workspace.machines.shareMachineLabel', 'Share machine')}
                  </span>
                  {sharing ? (
                    <Spinner size="small" />
                  ) : (
                    <Switch
                      checked={effectiveShared}
                      onCheckedChange={(checked) => void handleSharedToggle(checked)}
                      aria-label={t('workspace.machines.shareToggle', {
                        machineName: machine.name,
                        defaultValue: 'Share {{machineName}} with the team',
                      })}
                    />
                  )}
                </div>
              )}
              {restartVisible && (
                <Tooltip.Root>
                  <Tooltip.Trigger
                    render={
                      <Button
                        variant="ghost"
                        size="small"
                        icon
                        aria-label={t(
                          'settings.agent.machineLifecycle.restartButton',
                          'Restart daemon'
                        )}
                        disabled={restartingDaemon || upgradingDaemon}
                        onClick={() => void handleRestartDaemon()}
                      >
                        {restartingDaemon ? (
                          <Spinner size="small" />
                        ) : (
                          <RotateCcw {...stylex.props(styles.iconFill)} />
                        )}
                      </Button>
                    }
                  />
                  <Tooltip.Content>
                    {t('settings.agent.machineLifecycle.restartButton', 'Restart daemon')}
                  </Tooltip.Content>
                </Tooltip.Root>
              )}
              {managementGroupVisible && destructiveGroupVisible && (
                <div aria-hidden {...stylex.props(styles.groupRule)} />
              )}
              {revokeVisible && (
                <Tooltip.Root>
                  <Tooltip.Trigger
                    render={
                      <Button
                        variant="ghost"
                        size="small"
                        icon
                        tone="destructive"
                        aria-label={t(
                          'settings.devices.credentials.disconnect',
                          'Revoke machine access'
                        )}
                        onClick={() => setRevokeOpen(true)}
                      >
                        <Unplug {...stylex.props(styles.iconFill)} />
                      </Button>
                    }
                  />
                  <Tooltip.Content>
                    {t('settings.devices.credentials.disconnect', 'Revoke machine access')}
                  </Tooltip.Content>
                </Tooltip.Root>
              )}
              {removeVisible ? (
                <Tooltip.Root>
                  <Tooltip.Trigger
                    render={
                      <span {...stylex.props(styles.tooltipAnchor)}>
                        <Button
                          variant="ghost"
                          size="small"
                          tone="destructive"
                          aria-label={t(
                            'workspace.machines.removeFromWorkspace',
                            'Remove from workspace'
                          )}
                          disabled={!canDelete}
                          onClick={() => setDeleteOpen(true)}
                        >
                          <LogOut {...stylex.props(styles.icon14)} />
                          {t('workspace.machines.removeFromWorkspace', 'Remove from workspace')}
                        </Button>
                      </span>
                    }
                  />
                  {!canDelete ? (
                    <Tooltip.Content>
                      {t(
                        'workspace.machines.removeUnavailableOnline',
                        'Stop Lody on this machine before removing it from this workspace.'
                      )}
                    </Tooltip.Content>
                  ) : null}
                </Tooltip.Root>
              ) : null}
              {actionsMenuVisible && (
                <Menu.Root>
                  <Menu.Trigger
                    render={
                      <Button
                        variant="ghost"
                        size="small"
                        icon
                        aria-label={t('workspace.machines.moreActions', 'Machine options')}
                      >
                        {sharing ? (
                          <Spinner size="small" />
                        ) : (
                          <MoreHorizontal {...stylex.props(styles.iconFill)} />
                        )}
                      </Button>
                    }
                  />
                  <Menu.Content
                    align="end"
                    finalFocus={() => {
                      if (!pendingRenameRef.current) return undefined;
                      pendingRenameRef.current = false;
                      requestAnimationFrame(() => {
                        inputRef.current?.focus();
                        inputRef.current?.select();
                      });
                      return false;
                    }}
                  >
                    {isMobile && manageableOwnMachine && (
                      <Menu.Item
                        icon={<Pencil {...stylex.props(styles.iconFill)} />}
                        onClick={() => {
                          pendingRenameRef.current = true;
                          setRenaming(true);
                        }}
                      >
                        {t('workspace.machines.editName', 'Edit machine name')}
                      </Menu.Item>
                    )}
                    {isMobile && manageableOwnMachine && onSharedWithTeamChange && (
                      <Menu.Item
                        closeOnClick={false}
                        onClick={() => {
                          if (sharing) return;
                          void handleSharedToggle(!effectiveShared);
                        }}
                        disabled={sharing}
                        icon={<Users {...stylex.props(styles.iconFill)} />}
                        endContent={
                          <Switch
                            checked={effectiveShared}
                            disabled={sharing}
                            aria-hidden
                            tabIndex={-1}
                            className={stylex.props(styles.switchInMenu).className}
                          />
                        }
                      >
                        {t('workspace.machines.shareMachineLabel', 'Share machine')}
                      </Menu.Item>
                    )}
                    {isMobile &&
                      isOwn &&
                      (onPing || (updateVisible && daemonUpdate) || onRestartDaemon) && (
                        <Menu.Separator />
                      )}
                    {isMobile && onPing && (
                      <Menu.Item
                        closeOnClick={false}
                        onClick={() => {
                          void handlePing();
                        }}
                        disabled={pinging}
                        icon={
                          pinging ? (
                            <Spinner size="small" />
                          ) : (
                            <Activity {...stylex.props(styles.iconFill)} />
                          )
                        }
                        shortcut={
                          pingLatencyMs !== null ? (
                            <span {...stylex.props(styles.mono)}>
                              {t('settings.agent.machinePing.latency', '{{latency}} ms', {
                                latency: String(pingLatencyMs),
                              })}
                            </span>
                          ) : undefined
                        }
                      >
                        {t('settings.agent.machinePing.button', 'Ping')}
                      </Menu.Item>
                    )}
                    {isMobile && updateVisible && daemonUpdate && (
                      <Menu.Item
                        onClick={() => void handleUpgradeDaemon()}
                        disabled={restartingDaemon || upgradingDaemon}
                        icon={
                          upgradingDaemon ? (
                            <Spinner size="small" />
                          ) : (
                            <Download {...stylex.props(styles.iconFill)} />
                          )
                        }
                      >
                        {t(
                          'settings.agent.machineLifecycle.upgradeAndRestartButton',
                          'Update and restart'
                        )}
                      </Menu.Item>
                    )}
                    {onRestartDaemon && (
                      <Menu.Item
                        onClick={() => void handleRestartDaemon()}
                        disabled={restartingDaemon || upgradingDaemon}
                        icon={
                          restartingDaemon ? (
                            <Spinner size="small" />
                          ) : (
                            <RotateCcw {...stylex.props(styles.iconFill)} />
                          )
                        }
                      >
                        {t('settings.agent.machineLifecycle.restartButton', 'Restart daemon')}
                      </Menu.Item>
                    )}
                    {isMobile && isOwn && (
                      <>
                        <Menu.Separator />
                        <Menu.Item
                          closeOnClick={false}
                          onClick={() => {
                            setDeleteOpen(true);
                          }}
                          disabled={!canDelete}
                          tone="destructive"
                          icon={<LogOut {...stylex.props(styles.iconFill)} />}
                        >
                          {canDelete
                            ? t('workspace.machines.removeFromWorkspace', 'Remove from workspace')
                            : t(
                                'workspace.machines.removeUnavailableOnlineShort',
                                'Stop machine before removing'
                              )}
                        </Menu.Item>
                      </>
                    )}
                  </Menu.Content>
                </Menu.Root>
              )}
              {accordion && !externalAccordionHeader ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  icon
                  aria-label={t('settings.machines.collapseMachine', {
                    machine: machine.name || machine.id,
                    defaultValue: 'Collapse {{machine}}',
                  })}
                  aria-expanded={true}
                  onClick={accordion.onCollapse}
                >
                  <ChevronUp {...stylex.props(styles.iconFill)} aria-hidden />
                </Button>
              ) : null}
              {accordion && !externalAccordionHeader ? (
                <WorkspaceMachineOwnerAvatar owner={accordion.meta.owner} />
              ) : null}
            </div>
          </MobileSettingsDetailHeader>
          {/* Desktop (story) keeps the meta badges in the header; on mobile they
            move to the first line of the content, flush with the body. */}
          {!isMobile && accordion ? (
            externalAccordionHeader ? null : (
              <div {...stylex.props(styles.summaryRow)}>
                <WorkspaceMachineAccordionSummary meta={accordion.meta} showOwner={false} />
              </div>
            )
          ) : !isMobile ? (
            <div {...stylex.props(styles.metaRow)}>{metaBadges}</div>
          ) : null}
          {updateVisible && daemonUpdate && (
            <div {...stylex.props(surface.formBlock, styles.update)}>
              <div {...stylex.props(styles.updateText)}>
                <div {...stylex.props(styles.updateTitle)}>
                  {t('settings.agent.machineLifecycle.updateAvailable', 'Update available')}
                </div>
                <div {...stylex.props(styles.updateVersion)}>
                  {t(
                    'settings.agent.machineLifecycle.updateVersion',
                    'v{{current}} -> v{{latest}}',
                    {
                      current: daemonUpdate.currentVersion,
                      latest: daemonUpdate.latestVersion,
                    }
                  )}
                </div>
              </div>
              <Button
                size="small"
                disabled={restartingDaemon || upgradingDaemon}
                onClick={() => void handleUpgradeDaemon()}
              >
                {upgradingDaemon ? (
                  <Spinner size="small" />
                ) : (
                  <Download {...stylex.props(styles.icon14)} />
                )}
                {t('settings.agent.machineLifecycle.upgradeAndRestartButton', 'Update and restart')}
              </Button>
            </div>
          )}
        </header>
      ) : null}

      <div {...stylex.props(styles.body, accordion && styles.bodyInAccordion)}>
        {isMobile && (
          <div {...stylex.props(styles.metaRow, styles.metaRowMobile)}>{metaBadges}</div>
        )}
        {mode === 'devices' ? (
          <>
            {footer}
            <DeviceResourceMonitor
              snapshot={monitorSnapshot}
              state={monitorState}
              sessionMetas={monitorSessionMetas}
              agentConfigs={configs}
              onOpenSession={onOpenMonitorSession}
              onTerminateSession={onTerminateMonitorSession}
            />
          </>
        ) : (
          <MachineProvidersSection
            machine={machine}
            configs={configs}
            setups={setups}
            onAddConfig={onAddConfig}
            onEditConfig={onEditConfig}
            onDeleteConfig={onDeleteConfig}
            onRefreshConfig={onRefreshConfig}
            onRetrySetup={onRetrySetup}
            onDeleteSetup={onDeleteSetup}
          />
        )}
      </div>

      <AlertDialog.Root open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('workspace.machines.removeConfirmTitle', 'Remove machine from workspace?')}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t('workspace.machines.removeConfirmDescription', {
                machineName: machine.name,
                defaultValue:
                  'Remove {{machineName}} from this workspace. It can appear again if it reconnects to this workspace later.',
              })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={deleting}>
              {t('common.cancel', 'Cancel')}
            </AlertDialog.Cancel>
            <Button
              disabled={deleting}
              onClick={() => {
                void handleDelete();
              }}
              variant="destructive"
            >
              {deleting && <Spinner size="small" />}
              {t('workspace.machines.removeAction', 'Remove')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>

      <AlertDialog.Root open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('settings.devices.credentials.confirmTitle', 'Revoke machine access?')}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t(
                'settings.devices.credentials.confirmDescription',
                '{{machine}} will be signed out of every workspace. To reconnect it, create a new machine connection request.',
                { machine: machine.name }
              )}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={revoking}>
              {t('common.cancel', 'Cancel')}
            </AlertDialog.Cancel>
            <Button
              disabled={revoking}
              onClick={() => {
                setRevoking(true);
                void onRevokeCredentials?.()
                  .then(() => setRevokeOpen(false))
                  .catch(() => {
                    // Failure: the callback surfaces the error toast itself;
                    // keep the dialog open so "still not revoked" stays visible.
                  })
                  .finally(() => setRevoking(false));
              }}
              variant="destructive"
            >
              {revoking ? <Spinner size="small" /> : null}
              {t('settings.devices.credentials.disconnect', 'Revoke machine access')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>
  );
}

/** The empty list, standing in for the card's rows. */
function EmptyProviders({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.empty)}>
      <Bot {...stylex.props(styles.emptyIcon)} />
      <p {...stylex.props(styles.emptyCopy)}>
        {t('settings.agent.provider.empty', 'No providers on this machine yet.')}
      </p>
      <Button variant="secondary" size="small" onClick={onAdd}>
        <Plus {...stylex.props(styles.icon14)} />
        {t('settings.agent.provider.addProvider', 'Add provider')}
      </Button>
    </div>
  );
}
