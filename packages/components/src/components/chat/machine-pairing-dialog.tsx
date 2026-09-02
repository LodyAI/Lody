import { useEffect, useMemo, useState } from 'react';
import { getServerNow, type MachinePairingStatus } from '@lody/shared';
import {
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Laptop,
  Loader2,
  Terminal,
  TerminalSquare,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useConvexErrorMessage } from '@/hooks/use-convex-error-message';

import { writeTextToClipboard } from '@/lib/clipboard';
import { Button } from '@lody/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

const LODY_DESKTOP_DOWNLOAD_URL = 'https://lody.ai/download';

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        {connected ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-status-success" aria-hidden="true" />
                {t('machinePairing.connectedTitle', 'Machine connected')}
              </DialogTitle>
              <DialogDescription>
                {t(
                  'machinePairing.configureDescription',
                  'Configure the coding agents available on {{machine}}.',
                  { machine: machineName ?? machineId }
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
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
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('machinePairing.title', 'Connect a machine')}</DialogTitle>
              <DialogDescription>
                {t(
                  'machinePairing.description',
                  'Download the Lody desktop app, or run the command below on the machine you want to connect.'
                )}
              </DialogDescription>
            </DialogHeader>

            {creating ? (
              <div className="flex min-h-40 items-center justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
              </div>
            ) : createError ? (
              <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
                <p className="text-sm text-destructive">
                  {t('machinePairing.createFailed', 'Could not create a connection request.')}
                </p>
                <Button variant="secondary" onClick={onRetry}>
                  {t('common.retry', 'Retry')}
                </Button>
              </div>
            ) : status === 'pending' ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-border p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
                      <Laptop className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {t('machinePairing.desktopOptionTitle', 'Lody Desktop')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t(
                          'machinePairing.desktopOptionDescription',
                          'Install the desktop app to connect this machine.'
                        )}
                      </p>
                    </div>
                  </div>
                  <Button className="mt-3 w-full" onClick={downloadDesktop}>
                    <Download className="h-4 w-4" aria-hidden="true" />
                    {t('machinePairing.downloadDesktop', 'Download Lody Desktop')}
                  </Button>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <div className="h-px flex-1 bg-border" />
                  {t('common.or', 'or')}
                  <div className="h-px flex-1 bg-border" />
                </div>
                <div className="rounded-lg border border-border p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
                      <Terminal className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {t('machinePairing.cliOptionTitle', 'Command line')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t(
                          'machinePairing.cliOptionDescription',
                          'Run this command on the machine you want to connect.'
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="relative mt-3 rounded-md border border-border bg-muted/40 p-3 pr-11">
                    <code className="block whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground">
                      {command}
                    </code>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          icon
                          className="absolute right-1.5 top-1.5"
                          onClick={() => void copyCommand()}
                          aria-label={t('machinePairing.copyCommand', 'Copy command')}
                        >
                          <Copy className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {t('machinePairing.copyCommand', 'Copy command')}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {t(
                      'machinePairing.expiresIn',
                      'This command expires in {{time}} and can only be used to connect one machine.',
                      { time: remainingLabel ?? '30:00' }
                    )}
                  </p>
                </div>
              </div>
            ) : status === 'claimed' ? (
              <div className="flex min-h-44 flex-col items-center justify-center gap-3 text-center">
                <TerminalSquare className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium">
                    {t('machinePairing.claimed', 'Machine is signing in')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('machinePairing.preparingAgents', 'Preparing agent configuration…')}
                  </p>
                </div>
                <Loader2
                  className="h-4 w-4 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
              </div>
            ) : (
              <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
                <p className="text-sm text-muted-foreground">
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
              <DialogFooter>
                <Button variant="ghost" onClick={() => void cancel()}>
                  {t('machinePairing.cancelRequest', 'Cancel connection request')}
                </Button>
              </DialogFooter>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
