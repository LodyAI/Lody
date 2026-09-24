import { useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { RefreshCw, Trash2 } from 'lucide-react';
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
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { AlertDialog } from '@/ui/dialog';
import { withClassName } from '@/lib/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useMachineAcpBinaryProgress } from '@/hooks/use-machine-acp-binary-progress';
import { AgentIcon } from '@/components/icons/agent-icon';
import { CodexResetForecastChip } from '@/components/codex-reset/codex-reset-forecast-entry';
import { canShowCodexResetForecast } from '@/lib/codex-reset-forecast';
import {
  canShowSubscriptionRateLimits,
  formatAgentRateLimitWindowLabel,
  formatRateLimitWindowShortLabel,
  getAgentRateLimitEntries,
  getAgentRateLimitWindows,
} from '@/lib/session-usage';

/** Wide enough in its own container to set the meters beside the name. */
const ROOMY = '@container (min-width: 24rem)';

const styles = stylex.create({
  /** A line of the machine's provider card; the list draws the card and the rules. */
  root: { minWidth: 0, containerType: 'inline-size' },
  row: { display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 },
  main: { gap: space[2], paddingInline: space[3], paddingBlock: space[1.5] },
  mainList: { gap: space[3], paddingInline: space[4], paddingBlock: space[3] },
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
  badge: { textTransform: 'capitalize' },
  trailing: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[2],
    paddingInlineEnd: space[3],
    paddingBlock: space[1.5],
    fontSize: '0.75em',
    color: colors.secondaryLabel,
  },
  trailingList: { paddingBlock: space[3] },
  /** The meters sit beside the name when the row has room, and under it when not. */
  metersInline: {
    display: { default: 'none', [ROOMY]: 'flex' },
    alignItems: 'center',
    gap: '10px',
  },
  metersBelow: {
    display: { default: 'flex', [ROOMY]: 'none' },
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: '20px',
    rowGap: space[1],
    paddingInline: space[3],
    paddingTop: '2px',
    paddingBottom: '10px',
  },
  progress: {
    maxWidth: '9rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meter: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1.5],
    fontSize: '11px',
    color: colors.secondaryLabel,
  },
  /** A meter measures rather than progresses, so it is a gray track and fill. */
  track: {
    position: 'relative',
    width: '40px',
    height: '4px',
    overflow: 'hidden',
    borderRadius: '9999px',
    backgroundColor: colors.gray5,
  },
  fill: {
    position: 'absolute',
    insetBlock: 0,
    insetInlineStart: 0,
    borderRadius: '9999px',
    backgroundColor: colors.gray,
  },
  fillWidth: (percent: number) => ({ width: `${percent}%` }),
  percent: {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontVariantNumeric: 'tabular-nums',
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
  className,
}: ProviderRowProps) {
  const { t } = useTranslation();
  const { cliType, agentType } = config;
  const envCount = Object.keys(config.env || {}).length;
  const showRateLimits =
    canShowSubscriptionRateLimits({ cliType, agentType, config }) &&
    !!machine?.raceLimits &&
    Object.keys(machine.raceLimits).some(
      (key) => parseRateLimitEntryKey(key).cliType === agentType
    );

  // Compact usage meters shown inline after the provider name.
  const rateLimitWindows = useMemo(() => {
    if (!showRateLimits || !machine?.raceLimits) return [];
    for (const entry of getAgentRateLimitEntries(machine.raceLimits, agentType)) {
      const windows = getAgentRateLimitWindows(entry.limits);
      if (windows.length > 0) return windows;
    }
    return [];
  }, [showRateLimits, machine?.raceLimits, agentType]);

  // Codex-only: the third-party reset forecast for OpenAI's own usage limits.
  const showResetForecast = canShowCodexResetForecast({ cliType, agentType, config });

  const typeBadge = cliType === 'builtin' ? null : cliType === 'custom' ? 'Custom' : 'Registry';

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
              {typeBadge ? (
                <Badge>
                  <span {...stylex.props(styles.badge)}>{typeBadge}</span>
                </Badge>
              ) : null}
            </div>
          </div>
        </button>
        <div {...stylex.props(styles.trailing, !compact && styles.trailingList)}>
          {/* Not mounted at all when ineligible, so a non-Codex row costs no
              store subscription and no clock tick. */}
          {showResetForecast ? <CodexResetForecastChip enabled /> : null}
          {rateLimitWindows.length > 0 && compact && (
            <div {...stylex.props(styles.metersInline)}>
              {rateLimitWindows.map((window, index) => (
                <RateLimitMeter
                  key={`${window.windowDurationSeconds ?? 'unknown'}-${index}`}
                  label={formatAgentRateLimitWindowLabel(
                    window,
                    formatRateLimitWindowShortLabel(window.windowDurationSeconds),
                    t
                  )}
                  remainingPercent={window.remainingPercent}
                />
              ))}
            </div>
          )}
          {envCount > 0 && (
            <span>{t('settings.agent.provider.envCount', { count: envCount })}</span>
          )}
          {refreshing && binaryProgressText ? (
            <span {...stylex.props(styles.progress)}>{binaryProgressText}</span>
          ) : null}
          {onRefresh && (
            <Button
              variant="ghost"
              size="small"
              icon
              disabled={refreshing}
              aria-label={t(
                'agents.acpCapabilities.refreshModelsAndModes',
                'Refresh models and modes'
              )}
              onClick={(event) => {
                event.stopPropagation();
                void handleRefresh();
              }}
            >
              {refreshing ? (
                <Spinner size="small" />
              ) : (
                <RefreshCw {...stylex.props(catalog.icon)} />
              )}
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              aria-label={t('common.delete', 'Delete')}
              size="small"
              icon
              tone="destructive"
              onClick={(event) => {
                event.stopPropagation();
                setDeleteOpen(true);
              }}
            >
              <Trash2 {...stylex.props(catalog.icon)} />
            </Button>
          )}
        </div>
      </div>
      {rateLimitWindows.length > 0 && compact && (
        <div {...stylex.props(styles.metersBelow)}>
          {rateLimitWindows.map((window, index) => (
            <RateLimitMeter
              key={`${window.windowDurationSeconds ?? 'unknown'}-${index}`}
              label={formatRateLimitWindowShortLabel(window.windowDurationSeconds)}
              remainingPercent={window.remainingPercent}
            />
          ))}
        </div>
      )}
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

function RateLimitMeter({
  label,
  remainingPercent,
}: {
  label: string;
  remainingPercent: number | null;
}) {
  const pct = remainingPercent == null ? 0 : Math.min(100, Math.max(0, remainingPercent));
  const percentText = remainingPercent == null ? '—' : `${Math.round(remainingPercent)}%`;
  return (
    <span {...stylex.props(styles.meter)} title={`${label}: ${percentText}`}>
      <span>{label}</span>
      <span {...stylex.props(styles.track)}>
        <span {...stylex.props(styles.fill, styles.fillWidth(pct))} />
      </span>
      <span {...stylex.props(styles.percent)}>{percentText}</span>
    </span>
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
