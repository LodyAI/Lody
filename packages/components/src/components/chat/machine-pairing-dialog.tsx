import { useEffect, useMemo, useState } from 'react';
import { getServerNow, type MachinePairingStatus } from '@lody/shared';
import {
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Laptop,
  Terminal,
  TerminalSquare,
} from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { useConvexErrorMessage } from '@/hooks/use-convex-error-message';

import { writeTextToClipboard } from '@/lib/clipboard';
import { Button } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { Tooltip } from '@lody/ui/tooltip';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const LODY_DESKTOP_DOWNLOAD_URL = 'https://lody.ai/download';

const styles = stylex.create({
  /* Glyphs */
  icon20: { width: themeSpace[5], height: themeSpace[5] },
  icon16: { width: themeSpace[4], height: themeSpace[4] },
  icon14: { width: themeSpace[3.5], height: themeSpace[3.5] },
  icon32: { width: themeSpace[8], height: themeSpace[8] },
  iconMuted: { color: themeColors.mutedForeground },
  iconSuccess: { color: themeColors.statusSuccess },
  iconShrink: { flexShrink: 0 },

  /* The body of the dialog */
  waiting: {
    display: 'flex',
    minHeight: 'calc(var(--spacing) * 40)',
    alignItems: 'center',
    justifyContent: 'center',
    color: themeColors.mutedForeground,
  },
  centered: {
    display: 'flex',
    minHeight: 'calc(var(--spacing) * 40)',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[3],
    textAlign: 'center',
  },
  centeredTall: {
    display: 'flex',
    minHeight: 'calc(var(--spacing) * 44)',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[3],
    textAlign: 'center',
  },
  stack: { display: 'flex', flexDirection: 'column', gap: themeSpace[3] },
  errorText: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.destructive,
  },
  mutedText: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  title: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
  },
  caption: {
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },

  /* One option card */
  option: {
    borderRadius: themeRadius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: themeColors.border,
    padding: themeSpace[4],
  },
  optionRow: { display: 'flex', alignItems: 'center', gap: themeSpace[3] },
  optionGlyph: {
    display: 'flex',
    height: themeSpace[9],
    width: themeSpace[9],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.md,
    backgroundColor: themeColors.muted,
  },
  optionText: { minWidth: 0 },

  /* The "or" rule between the two options */
  divider: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[3],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
  dividerRule: {
    height: '1px',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    backgroundColor: themeColors.border,
  },

  /* The command */
  command: {
    position: 'relative',
    marginTop: themeSpace[3],
    borderRadius: themeRadius.md,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: themeColors.border,
    backgroundColor: 'hsl(var(--muted) / 0.4)',
    padding: themeSpace[3],
    paddingRight: themeSpace[11],
  },
  commandText: {
    display: 'block',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    fontSize: themeFontSize.xs,
    lineHeight: themeSpace[5],
    color: themeColors.foreground,
  },
  expiry: {
    marginTop: themeSpace[3],
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
});

export type MachinePairingDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string | null;
  status: MachinePairingStatus | null;
  machineId?: string;
  machineName?: string;
  command: string | null;
  expiresAt: number | null;
  creating: boolean;
  createError: string | null;
  onRetry: () => void;
  onCancelRequest: () => Promise<void>;
  onConfigureAgents: () => void;
};

function formatRemainingTime(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function MachinePairingDialog({
  open,
  onOpenChange,
  requestId,
  status,
  machineId,
  machineName,
  command,
  expiresAt,
  creating,
  createError,
  onRetry,
  onCancelRequest,
  onConfigureAgents,
}: MachinePairingDialogProps) {
  const { t } = useTranslation();
  const getConvexErrorMessage = useConvexErrorMessage();
  const [now, setNow] = useState(() => getServerNow());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(getServerNow()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const remainingLabel = useMemo(
    () => (expiresAt ? formatRemainingTime(expiresAt - now) : null),
    [expiresAt, now]
  );

  const copyCommand = async () => {
    if (!command) return;
    const copied = await writeTextToClipboard(command);
    if (copied) {
      toast.success(t('machinePairing.commandCopied', 'Command copied'));
    } else {
      toast.error(t('machinePairing.commandCopyFailed', 'Could not copy command'));
    }
  };

  const cancel = async () => {
    if (!requestId) return;
    try {
      await onCancelRequest();
      onOpenChange(false);
    } catch (error) {
      toast.error(
        getConvexErrorMessage(
          error,
          t('machinePairing.cancelFailed', 'Could not cancel this request')
        )
      );
    }
  };

  const downloadDesktop = () => {
    window.open(LODY_DESKTOP_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');
  };

  const connected = status === 'registered' && machineId;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content width="36rem">
        {connected ? (
          <>
            <Dialog.Header>
              <Dialog.Title className="flex items-center gap-2">
                <CheckCircle2
                  {...stylex.props(styles.icon20, styles.iconSuccess)}
                  aria-hidden="true"
                />
                {t('machinePairing.connectedTitle', 'Machine connected')}
              </Dialog.Title>
              <Dialog.Description>
                {t(
                  'machinePairing.configureDescription',
                  'Configure the coding agents available on {{machine}}.',
                  { machine: machineName ?? machineId }
                )}
              </Dialog.Description>
            </Dialog.Header>
            <Dialog.Footer>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t('machinePairing.skipAgentSetup', 'Skip for now')}
              </Button>
              <Button
                onClick={() => {
                  onOpenChange(false);
                  onConfigureAgents();
                }}
              >
                {t('machinePairing.configureAgents', 'Configure agents')}
              </Button>
            </Dialog.Footer>
          </>
        ) : (
          <>
            <Dialog.Header>
              <Dialog.Title>{t('machinePairing.title', 'Connect a machine')}</Dialog.Title>
              <Dialog.Description>
                {t(
                  'machinePairing.description',
                  'Download the Lody desktop app, or run the command below on the machine you want to connect.'
                )}
              </Dialog.Description>
            </Dialog.Header>

            {creating ? (
              <div {...stylex.props(styles.waiting)}>
                <Spinner diameter="calc(var(--spacing) * 5)" aria-hidden="true" />
              </div>
            ) : createError ? (
              <div {...stylex.props(styles.centered)}>
                <p {...stylex.props(styles.errorText)}>
                  {t('machinePairing.createFailed', 'Could not create a connection request.')}
                </p>
                <Button variant="secondary" onClick={onRetry}>
                  {t('common.retry', 'Retry')}
                </Button>
              </div>
            ) : status === 'pending' ? (
              <div {...stylex.props(styles.stack)}>
                <div {...stylex.props(styles.option)}>
                  <div {...stylex.props(styles.optionRow)}>
                    <div {...stylex.props(styles.optionGlyph)}>
                      <Laptop
                        {...stylex.props(styles.icon16, styles.iconMuted)}
                        aria-hidden="true"
                      />
                    </div>
                    <div {...stylex.props(styles.optionText)}>
                      <p {...stylex.props(styles.title)}>
                        {t('machinePairing.desktopOptionTitle', 'Lody Desktop')}
                      </p>
                      <p {...stylex.props(styles.caption)}>
                        {t(
                          'machinePairing.desktopOptionDescription',
                          'Install the desktop app to connect this machine.'
                        )}
                      </p>
                    </div>
                  </div>
                  <Button width="100%" className="mt-3" onClick={downloadDesktop}>
                    <Download {...stylex.props(styles.icon16)} aria-hidden="true" />
                    {t('machinePairing.downloadDesktop', 'Download Lody Desktop')}
                  </Button>
                </div>
                <div {...stylex.props(styles.divider)}>
                  <div {...stylex.props(styles.dividerRule)} />
                  {t('common.or', 'or')}
                  <div {...stylex.props(styles.dividerRule)} />
                </div>
                <div {...stylex.props(styles.option)}>
                  <div {...stylex.props(styles.optionRow)}>
                    <div {...stylex.props(styles.optionGlyph)}>
                      <Terminal
                        {...stylex.props(styles.icon16, styles.iconMuted)}
                        aria-hidden="true"
                      />
                    </div>
                    <div {...stylex.props(styles.optionText)}>
                      <p {...stylex.props(styles.title)}>
                        {t('machinePairing.cliOptionTitle', 'Command line')}
                      </p>
                      <p {...stylex.props(styles.caption)}>
                        {t(
                          'machinePairing.cliOptionDescription',
                          'Run this command on the machine you want to connect.'
                        )}
                      </p>
                    </div>
                  </div>
                  <div {...stylex.props(styles.command)}>
                    {/* `font-mono` is the app's own global class, and its rule
                        already names `code`, so the element keeps the mono face
                        without the class. */}
                    <code {...stylex.props(styles.commandText)}>{command}</code>
                    <Tooltip.Root>
                      <Tooltip.Trigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            icon
                            className="absolute right-1.5 top-1.5"
                            onClick={() => void copyCommand()}
                            aria-label={t('machinePairing.copyCommand', 'Copy command')}
                          >
                            <Copy {...stylex.props(styles.icon16)} aria-hidden="true" />
                          </Button>
                        }
                      />
                      <Tooltip.Content>
                        {t('machinePairing.copyCommand', 'Copy command')}
                      </Tooltip.Content>
                    </Tooltip.Root>
                  </div>
                  <p {...stylex.props(styles.expiry)}>
                    <Clock {...stylex.props(styles.icon14, styles.iconShrink)} aria-hidden="true" />
                    {t(
                      'machinePairing.expiresIn',
                      'This command expires in {{time}} and can only be used to connect one machine.',
                      { time: remainingLabel ?? '30:00' }
                    )}
                  </p>
                </div>
              </div>
            ) : status === 'claimed' ? (
              <div {...stylex.props(styles.centeredTall)}>
                <TerminalSquare
                  {...stylex.props(styles.icon32, styles.iconMuted)}
                  aria-hidden="true"
                />
                <div>
                  <p {...stylex.props(styles.title)}>
                    {t('machinePairing.claimed', 'Machine is signing in')}
                  </p>
                  <p {...stylex.props(styles.caption)}>
                    {t('machinePairing.preparingAgents', 'Preparing agent configuration…')}
                  </p>
                </div>
                <Spinner
                  diameter="calc(var(--spacing) * 4)"
                  className="text-muted-foreground"
                  aria-hidden="true"
                />
              </div>
            ) : (
              <div {...stylex.props(styles.centered)}>
                <p {...stylex.props(styles.mutedText)}>
                  {status === 'cancelled'
                    ? t('machinePairing.cancelled', 'This connection request was cancelled.')
                    : t('machinePairing.expired', 'This connection request has expired.')}
                </p>
                <Button variant="secondary" onClick={onRetry}>
                  {t('machinePairing.createNew', 'Create a new request')}
                </Button>
              </div>
            )}

            {status === 'pending' || status === 'claimed' ? (
              <Dialog.Footer>
                <Button variant="ghost" onClick={() => void cancel()}>
                  {t('machinePairing.cancelRequest', 'Cancel connection request')}
                </Button>
              </Dialog.Footer>
            ) : null}
          </>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
