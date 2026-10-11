import { text as uiText } from '@lody/ui/tokens/scales.stylex';
import { useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { MoreHorizontal, RefreshCw, Trash2 } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import {
  REGISTRY_ACP_AGENTS,
  type AgentConfigCliType,
  type AgentConfigMeta,
  type MachineAcpBinaryProgressMessage,
  type MachineViewMeta,
  parseRateLimitEntryKey,
} from '@lody/shared';
import { toast } from '@/lib/toast';
import { Button } from '@lody/ui/button';
import { AlertDialog } from '@/ui/dialog';
import { withClassName } from '@/lib/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useMachineAcpBinaryProgress } from '@/hooks/use-machine-acp-binary-progress';
import { AgentIcon } from '@/components/icons/agent-icon';
import { useAcpSelectorOptions } from '@/hooks/use-acp-selector-options';
import { formatLocalizedRelativeTime } from '@/lib/format-relative-time';
import { Menu } from '@lody/ui/menu';
import { ProviderUsageSummary } from './provider-usage-summary';
import { canShowCodexResetForecast } from '@/lib/codex-reset-forecast';
import {
  canShowSubscriptionRateLimits,
  getAgentRateLimitEntries,
  getAgentRateLimitWindows,
} from '@/lib/session-usage';

/** The panel, rather than the viewport, decides whether quota fits beside the name. */
const ROOMY = '@container (min-width: 28rem)';

const styles = stylex.create({
  root: { minWidth: 0, containerType: 'inline-size' },
  row: {
    display: 'grid',
    gridTemplateColumns: { default: 'minmax(0, 1fr) auto', [ROOMY]: 'minmax(0, 1fr) auto auto' },
    alignItems: 'center',
    minWidth: 0,
    paddingInlineEnd: space[4],
  },
  main: { gridColumn: 1, gridRow: 1, gap: '10px', paddingInline: space[4], paddingBlock: space[2] },
  mainList: {
    gridColumn: 1,
    gridRow: 1,
    gap: space[3],
    paddingInline: space[4],
    paddingBlock: space[3],
  },
  icon: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    color: colors.label,
  },
  iconList: { width: '32px', height: '32px' },
  glyph: { width: '16px', height: '16px' },
  glyphList: { width: '20px', height: '20px' },
  body: { flexGrow: 1, minWidth: 0 },
  usage: {
    gridColumn: { default: '1 / -1', [ROOMY]: '2' },
    gridRow: { default: 2, [ROOMY]: 1 },
    display: 'flex',
    justifyContent: { default: 'flex-start', [ROOMY]: 'flex-end' },
    paddingInlineStart: { default: '50px', [ROOMY]: 0 },
    paddingBottom: { default: space[2], [ROOMY]: 0 },
  },
  usageList: { paddingInlineStart: { default: '60px', [ROOMY]: 0 } },
  trailing: {
    gridColumn: { default: 2, [ROOMY]: 3 },
    gridRow: 1,
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    fontSize: uiText.footnoteSize,
    color: colors.secondaryLabel,
  },
  progress: {
    paddingInlineStart: '50px',
    paddingInlineEnd: space[4],
    paddingBottom: space[2],
    fontSize: uiText.captionSize,
    color: colors.secondaryLabel,
  },
});

export type ProviderRowProps = {
  config: AgentConfigMeta;
  machine: MachineViewMeta | undefined;
  onEdit: (config: AgentConfigMeta) => void;
  onDelete?: (config: AgentConfigMeta) => Promise<void>;
  onRefresh?: (config: AgentConfigMeta) => Promise<void>;
  /**
   * Density: `card` is the compact line of the desktop provider card, `list`
   * the roomier mobile one. Neither draws a surface: the list draws one card
   * for all its providers and the rule between them.
   */
  variant?: 'card' | 'list';
  /**
   * How much the provider is used on its machine. A compact row states it on
   * its second line, with the default model, so a short list still says what
   * each provider is for and whether anyone reaches for it.
   */
  usage?: { conversations: number; lastUsedAt: number | null };
  /** Layout only. */
  className?: string;
};

/** One provider entry, as a line of its machine's provider card. Signing in
 *  again lives in the provider's detail dialog (`AgentConfigDialog`), not here:
 *  only some providers can sign in at all. */
export function ProviderRow({
  config,
  machine,
  onEdit,
  onDelete,
  onRefresh,
  variant = 'card',
  usage,
  className,
}: ProviderRowProps) {
  const { t } = useTranslation();
  const { cliType, agentType } = config;
  const envCount = Object.keys(config.env || {}).length;
  // The cached capabilities the composer also reads; nothing is fetched here.
  const selector = useAcpSelectorOptions({
    configId: config.id,
    cliType,
    agentType,
    runtimeOverrides: config.runtimeOverrides,
    machine,
  });
  // A model the runtime calls "default" names nothing, so the row leaves it out.
  const defaultModel =
    selector.defaultModelId && selector.defaultModelId.toLowerCase() !== 'default'
      ? (selector.modelOptions.find((option) => option.value === selector.defaultModelId)?.label ??
        null)
      : null;
  const showRateLimits =
    canShowSubscriptionRateLimits({ cliType, agentType, config }) &&
    !!machine?.raceLimits &&
    Object.keys(machine.raceLimits).some((key) => {
      const parsed = parseRateLimitEntryKey(key);
      return parsed.cliType === agentType && parsed.agentConfigId === config.id;
    });

  // Reported subscription windows for this exact provider configuration.
  const rateLimitWindows = useMemo(() => {
    if (!showRateLimits || !machine?.raceLimits) return [];
    for (const entry of getAgentRateLimitEntries(machine.raceLimits, agentType, config.id)) {
      const windows = getAgentRateLimitWindows(entry.limits);
      if (windows.length > 0) return windows;
    }
    return [];
  }, [showRateLimits, machine?.raceLimits, agentType, config.id]);

  // Codex-only: the third-party reset forecast for OpenAI's own usage limits.
  const showResetForecast = canShowCodexResetForecast({ cliType, agentType, config });

  // What kind of provider this is, when it is not one Lody ships: a fact of the
  // meta line, in words, not a pill on every row.
  const kind =
    cliType === 'builtin'
      ? null
      : cliType === 'custom'
        ? t('settings.agent.dialog.group.custom', 'Custom')
        : t('settings.agent.dialog.group.registry', 'ACP Provider');

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const binaryProgress = useMachineAcpBinaryProgress(
    runtime,
    machine?.id ?? null,
    config.agentType
  );
  const binaryProgressText = binaryProgress ? formatBinaryProgressText(t, binaryProgress) : null;

  const handleDelete = async () => {
    if (!onDelete) return;
    try {
      setDeleting(true);
      await onDelete(config);
      setDeleteOpen(false);
    } catch (error) {
      toast.error(t('agents.deleteConfigError', 'Failed to delete configuration'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleRefresh = async () => {
    if (!onRefresh) return;
    try {
      setRefreshing(true);
      await onRefresh(config);
      toast.success(
        t('settings.agent.provider.refreshSuccess', 'Refreshed {{name}}', { name: config.name })
      );
    } catch (error) {
      toast.error(
        t('settings.agent.provider.refreshFailed', 'Failed to refresh {{agent}}', {
          agent: config.name,
        }),
        { description: error instanceof Error ? error.message : String(error) }
      );
    } finally {
      setRefreshing(false);
    }
  };

  const compact = variant === 'card';
  const hasUsageSummary = rateLimitWindows.length > 0 || showResetForecast;
  const facts = compact
    ? [
        kind,
        defaultModel,
        usage && usage.conversations > 0
          ? t('settings.agent.provider.conversationCount', '{{count}} conversations', {
              count: usage.conversations,
            })
          : null,
        usage?.lastUsedAt != null
          ? t('settings.agent.provider.lastUsed', 'Used {{ago}}', {
              ago: formatLocalizedRelativeTime(usage.lastUsedAt, t),
            })
          : null,
        envCount > 0 ? t('settings.agent.provider.envCount', { count: envCount }) : null,
      ].filter((fact): fact is string => fact != null)
    : [kind].filter((fact): fact is string => fact != null);
  return (
    <div {...withClassName(stylex.props(styles.root), className)}>
      <div {...stylex.props(styles.row, surface.pressableLine)}>
        <button
          type="button"
          onClick={() => onEdit(config)}
          {...stylex.props(catalog.rowMain, compact ? styles.main : styles.mainList)}
          aria-label={t('agents.editConfig', 'Edit config')}
        >
          <div {...stylex.props(styles.icon, !compact && styles.iconList)}>
            <AgentIcon
              cliType={cliType}
              agentType={agentType}
              brandId={config.brandId}
              env={config.env}
              className={stylex.props(compact ? styles.glyph : styles.glyphList).className}
            />
          </div>
          <div {...stylex.props(styles.body)}>
            <div {...stylex.props(catalog.titleLine)}>
              <span {...stylex.props(catalog.name)}>{config.name}</span>
            </div>
            {facts.length > 0 ? (
              <span {...stylex.props(catalog.meta)}>
                <span {...stylex.props(catalog.truncate)}>{facts.join(' · ')}</span>
              </span>
            ) : null}
          </div>
        </button>
        {hasUsageSummary ? (
          <div {...stylex.props(styles.usage, !compact && styles.usageList)}>
            <ProviderUsageSummary
              name={config.name}
              windows={rateLimitWindows}
              showResetForecast={showResetForecast}
            />
          </div>
        ) : null}
        <div {...stylex.props(styles.trailing)}>
          {envCount > 0 && !compact ? (
            <span>{t('settings.agent.provider.envCount', { count: envCount })}</span>
          ) : null}
          {onRefresh || onDelete ? (
            <Menu.Root>
              <Menu.Trigger
                render={
                  <Button
                    variant="ghost"
                    size="small"
                    icon
                    disabled={refreshing}
                    aria-label={t('settings.agent.provider.manage', 'Manage {{name}}', {
                      name: config.name,
                    })}
                  >
                    {refreshing ? (
                      <Spinner size="small" />
                    ) : (
                      <MoreHorizontal {...stylex.props(catalog.icon)} />
                    )}
                  </Button>
                }
              />
              <Menu.Content align="end" width="compact">
                {onRefresh ? (
                  <Menu.Item
                    icon={RefreshCw}
                    onClick={() => {
                      void handleRefresh();
                    }}
                  >
                    {t('agents.acpCapabilities.refreshModelsAndModes', 'Refresh models and modes')}
                  </Menu.Item>
                ) : null}
                {onRefresh && onDelete ? <Menu.Separator /> : null}
                {onDelete ? (
                  <Menu.Item icon={Trash2} tone="destructive" onClick={() => setDeleteOpen(true)}>
                    {t('common.delete', 'Delete')}
                  </Menu.Item>
                ) : null}
              </Menu.Content>
            </Menu.Root>
          ) : null}
        </div>
      </div>
      {refreshing && binaryProgressText ? (
        <div role="status" {...stylex.props(styles.progress)}>
          {binaryProgressText}
        </div>
      ) : null}
      <AlertDialog.Root open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('agents.deleteConfigConfirm', 'Delete Configuration')}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t('agents.deleteConfigConfirmDescription', {
                name: config.name,
                defaultValue:
                  'Are you sure you want to delete "{{name}}"? This action cannot be undone.',
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
              {t('common.delete', 'Delete')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>
  );
}

function formatBinaryProgressText(
  t: ReturnType<typeof useTranslation>['t'],
  progress: MachineAcpBinaryProgressMessage
): string {
  if (progress.status === 'downloading') {
    if (typeof progress.percent === 'number') {
      return t('settings.agent.provider.binaryDownloadingPercent', 'Downloading {{percent}}%', {
        percent: Math.round(progress.percent),
      });
    }
    return t('settings.agent.provider.binaryDownloading', 'Downloading');
  }
  if (progress.status === 'verifying') {
    return t('settings.agent.provider.binaryVerifying', 'Verifying');
  }
  if (progress.status === 'extracting') {
    return t('settings.agent.provider.binaryExtracting', 'Extracting');
  }
  if (progress.status === 'publishing') {
    return t('settings.agent.provider.binaryPublishing', 'Installing');
  }
  if (progress.status === 'not-installed') {
    return t('settings.agent.provider.binaryRequired', 'Download required');
  }
  if (progress.status === 'error') {
    return t('settings.agent.provider.binaryFailed', 'Download failed');
  }
  if (progress.status === 'installed') {
    return t('settings.agent.provider.binaryReady', 'Ready');
  }
  return t('settings.agent.provider.binaryChecking', 'Checking');
}

export function labelForAgent(cliType: AgentConfigCliType, agentType: string): string {
  if (cliType === 'builtin') {
    if (agentType === 'claude') return 'Claude';
    if (agentType === 'codex') return 'Codex';
    return agentType;
  }
  if (cliType === 'custom') {
    return 'Custom';
  }
  const registry = REGISTRY_ACP_AGENTS.find((a) => a.id === agentType);
  return registry?.name ?? agentType;
}
