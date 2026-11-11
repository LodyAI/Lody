import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import type { MachineLifecycleCapability, ManagedDaemonUpdateStatus } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text as uiText } from '@lody/ui/tokens/scales.stylex';
import { Dialog } from '@/ui/dialog';
import { buildDaemonInstallCommands } from '@/lib/daemon-installation';
import {
  deriveBatchRowStatus,
  planMachineBatchUpdate,
  type BatchMachineInput,
  type BatchPlanRow,
  type BatchRowStatus,
} from '@/lib/machine-batch-update';

export type BatchUpdateMachine = Omit<BatchMachineInput, 'lifecycle'>;
export type BatchUpdateProbe = {
  lifecycle: MachineLifecycleCapability | null;
  update?: ManagedDaemonUpdateStatus | null;
};
type SwitchPolicy = 'when-idle' | 'immediate';
type RequestState = {
  request: 'requesting' | 'accepted' | 'failed';
  error?: string;
  updatePhase?: ManagedDaemonUpdateStatus['phase'];
  offlineSinceMs?: number;
};

const styles = stylex.create({
  list: { display: 'flex', flexDirection: 'column', gap: space[2], marginBlock: space[3] },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
    paddingBlock: space[2],
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  rowLine: { display: 'flex', justifyContent: 'space-between', gap: space[3] },
  name: { fontSize: uiText.subheadlineSize, fontWeight: 500 },
  detail: { fontSize: uiText.footnoteSize, color: colors.secondaryLabel },
  danger: { fontSize: uiText.footnoteSize, color: colors.destructive },
  command: {
    fontFamily: 'var(--font-mono)',
    fontSize: uiText.footnoteSize,
    overflowWrap: 'anywhere',
    userSelect: 'all',
  },
  policy: { display: 'flex', gap: space[2], flexWrap: 'wrap' },
  warning: {
    fontSize: uiText.subheadlineSize,
    color: colors.destructive,
    marginBlockStart: space[2],
  },
});

const TERMINAL: ReadonlySet<BatchRowStatus['kind']> = new Set([
  'updated',
  'rolled-back',
  'blocked',
  'failed',
  'timed-out',
  'request-failed',
]);

/**
 * One-click update for every machine the user owns in this workspace. Each
 * machine is updated through its own owner-only `machine/upgrade`; a failure on
 * one never stops the others.
 */
export function MachineBatchUpdateDialog({
  open,
  onOpenChange,
  machines,
  latestVersion,
  probe,
  requestUpgrade,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machines: readonly BatchUpdateMachine[];
  latestVersion: string;
  probe: (machineId: string) => Promise<BatchUpdateProbe>;
  requestUpgrade: (machineId: string, target: string, policy: SwitchPolicy) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [lifecycleById, setLifecycleById] = useState<
    Map<string, MachineLifecycleCapability | null>
  >(new Map());
  const [probing, setProbing] = useState(false);
  const [policy, setPolicy] = useState<SwitchPolicy>('when-idle');
  const [step, setStep] = useState<'review' | 'confirm-immediate' | 'running'>('review');
  const [requests, setRequests] = useState<Map<string, RequestState>>(new Map());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const machinesRef = useRef(machines);
  machinesRef.current = machines;

  // Probe each owned online machine's lifecycle capability when the dialog opens.
  useEffect(() => {
    if (!open) return undefined;
    setStep('review');
    setRequests(new Map());
    setPolicy('when-idle');
    let cancelled = false;
    const targets = machinesRef.current.filter((machine) => machine.isOwn && machine.isOnline);
    setProbing(true);
    void Promise.all(
      targets.map(async (machine) => {
        const result = await probe(machine.id).catch(() => ({ lifecycle: null }));
        return [machine.id, result.lifecycle] as const;
      })
    ).then((entries) => {
      if (cancelled) return;
      setLifecycleById(new Map(entries));
      setProbing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, probe]);

  const plan = useMemo(
    () =>
      planMachineBatchUpdate(
        machines.map((machine) => ({
          ...machine,
          lifecycle: lifecycleById.get(machine.id) ?? null,
        })),
        latestVersion
      ),
    [machines, lifecycleById, latestVersion]
  );
  const updatable = plan.filter((row) => row.kind === 'update');
  const runningTotal = updatable.reduce((sum, row) => sum + row.runningSessionCount, 0);

  // Track when an accepted machine goes offline: the switch timeout starts there.
  useEffect(() => {
    if (step !== 'running') return;
    setRequests((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [machineId, state] of current) {
        const machine = machines.find((entry) => entry.id === machineId);
        if (state.request !== 'accepted' || !machine) continue;
        if (!machine.isOnline && state.offlineSinceMs === undefined) {
          next.set(machineId, { ...state, offlineSinceMs: Date.now() });
          changed = true;
        } else if (machine.isOnline && state.offlineSinceMs !== undefined) {
          next.set(machineId, { ...state, offlineSinceMs: undefined });
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [machines, step]);

  const statusOf = useCallback(
    (row: BatchPlanRow): BatchRowStatus | null => {
      const state = requests.get(row.machineId);
      if (!state) return null;
      const machine = machines.find((entry) => entry.id === row.machineId);
      return deriveBatchRowStatus({
        request: state.request,
        error: state.error,
        target: row.targetVersion,
        isOnline: machine?.isOnline ?? false,
        cliVersion: machine?.cliVersion,
        updatePhase: state.updatePhase,
        offlineSinceMs: state.offlineSinceMs,
        nowMs,
      });
    },
    [machines, nowMs, requests]
  );

  // While any accepted row is unfinished, refresh its update record and the clock.
  const pending = [...requests.keys()].filter((machineId) => {
    const row = plan.find((entry) => entry.machineId === machineId);
    const status = row ? statusOf(row) : null;
    return status !== null && !TERMINAL.has(status.kind);
  });
  const pendingKey = pending.join(',');
  useEffect(() => {
    if (step !== 'running' || pendingKey === '') return undefined;
    const timer = setInterval(() => {
      setNowMs(Date.now());
      for (const machineId of pendingKey.split(',')) {
        const machine = machinesRef.current.find((entry) => entry.id === machineId);
        if (!machine?.isOnline) continue;
        void probe(machineId)
          .then((result) => {
            const phase = result.update?.phase;
            if (!phase || phase === 'unconfirmed') return;
            setRequests((current) => {
              const state = current.get(machineId);
              if (!state || state.updatePhase === phase) return current;
              return new Map(current).set(machineId, { ...state, updatePhase: phase });
            });
          })
          .catch(() => {});
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [pendingKey, probe, step]);

  const start = useCallback(() => {
    setStep('running');
    setRequests(
      new Map(updatable.map((row) => [row.machineId, { request: 'requesting' } as RequestState]))
    );
    for (const row of updatable) {
      void requestUpgrade(row.machineId, row.targetVersion, policy).then(
        () =>
          setRequests((current) => new Map(current).set(row.machineId, { request: 'accepted' })),
        (error: unknown) =>
          setRequests((current) =>
            new Map(current).set(row.machineId, {
              request: 'failed',
              error: error instanceof Error ? error.message : String(error),
            })
          )
      );
    }
  }, [policy, requestUpgrade, updatable]);

  const confirm = () => {
    if (policy === 'immediate' && runningTotal > 0 && step === 'review') {
      setStep('confirm-immediate');
      return;
    }
    start();
  };

  const installCommand = useMemo(() => buildDaemonInstallCommands().command, []);
  const statusLabel = (status: BatchRowStatus): string =>
    ({
      requesting: t('settings.machines.batchUpdate.status.requesting', 'Sending request…'),
      'request-failed': t('settings.machines.batchUpdate.status.requestFailed', 'Request failed'),
      'waiting-idle': t(
        'settings.machines.batchUpdate.status.waitingIdle',
        'Waiting until no conversation is running'
      ),
      switching: t(
        'settings.machines.batchUpdate.status.switching',
        'Restarting on the new version…'
      ),
      updated: t('settings.machines.batchUpdate.status.updated', 'Updated'),
      'rolled-back': t(
        'settings.machines.batchUpdate.status.rolledBack',
        'New version failed its health check; rolled back'
      ),
      blocked: t(
        'settings.machines.batchUpdate.status.blocked',
        'Recovery blocked; check the daemon log on this machine'
      ),
      failed: t(
        'settings.machines.batchUpdate.status.failed',
        'Update failed or expired; not updated'
      ),
      'timed-out': t(
        'settings.machines.batchUpdate.status.timedOut',
        'Not back online after 5 minutes'
      ),
    })[status.kind];
  const reasonLabel = (row: BatchPlanRow): string => {
    switch (row.kind) {
      case 'offline':
        return t('settings.machines.batchUpdate.offline', 'Offline; skipped');
      case 'up-to-date':
        return t('settings.machines.batchUpdate.upToDate', 'Already up to date');
      case 'update':
        return t('settings.machines.batchUpdate.willUpdate', 'v{{current}} → v{{target}}', {
          current: row.currentVersion ?? '?',
          target: row.targetVersion,
        });
      default:
        return {
          desktop: t(
            'settings.machines.batchUpdate.unsupported.desktop',
            'Desktop app; update it on that computer'
          ),
          foreground: t(
            'settings.machines.batchUpdate.unsupported.foreground',
            'Started with lody start in a terminal; remote update needs the background daemon'
          ),
          install: t(
            'settings.machines.batchUpdate.unsupported.install',
            'This installation cannot update remotely (Windows, an encrypted workspace, or an older npm install). Run on that machine:'
          ),
          unknown: t(
            'settings.machines.batchUpdate.unsupported.unknown',
            'Could not read whether this machine can update remotely'
          ),
        }[row.reason ?? 'unknown'];
    }
  };

  const finished = step === 'running' && pending.length === 0 && requests.size > 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content data-testid="machine-batch-update-dialog">
        <Dialog.Header>
          <Dialog.Title>
            {t('settings.machines.batchUpdate.title', 'Update all my machines')}
          </Dialog.Title>
          <Dialog.Description>
            {t(
              'settings.machines.batchUpdate.description',
              'Each machine switches to v{{version}} on its own and rolls back automatically if the new version does not start.',
              { version: latestVersion }
            )}
          </Dialog.Description>
        </Dialog.Header>
        {probing ? (
          <Spinner size="small" />
        ) : (
          <div {...stylex.props(styles.list)}>
            {plan.map((row) => {
              const status = statusOf(row);
              return (
                <div
                  key={row.machineId}
                  data-machine-id={row.machineId}
                  {...stylex.props(styles.row)}
                >
                  <div {...stylex.props(styles.rowLine)}>
                    <span {...stylex.props(styles.name)}>{row.name}</span>
                    <span
                      {...stylex.props(
                        status && TERMINAL.has(status.kind) && status.kind !== 'updated'
                          ? styles.danger
                          : styles.detail
                      )}
                    >
                      {status ? statusLabel(status) : reasonLabel(row)}
                    </span>
                  </div>
                  {status?.kind === 'request-failed' && status.error ? (
                    <span {...stylex.props(styles.danger)}>{status.error}</span>
                  ) : null}
                  {!status && row.kind === 'update' && row.runningSessionCount > 0 ? (
                    <span {...stylex.props(styles.detail)}>
                      {t(
                        'settings.machines.batchUpdate.running',
                        '{{count}} conversations running',
                        { count: row.runningSessionCount }
                      )}
                    </span>
                  ) : null}
                  {!status && row.kind === 'unsupported' && row.reason === 'install' ? (
                    <code {...stylex.props(styles.command)}>{installCommand}</code>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        {step === 'review' && updatable.length > 0 ? (
          <div {...stylex.props(styles.policy)} role="radiogroup">
            <Button
              size="small"
              variant={policy === 'when-idle' ? 'secondary' : 'ghost'}
              role="radio"
              aria-checked={policy === 'when-idle'}
              onClick={() => setPolicy('when-idle')}
            >
              {t('settings.machines.batchUpdate.whenIdle', 'Update when idle')}
            </Button>
            <Button
              size="small"
              variant={policy === 'immediate' ? 'secondary' : 'ghost'}
              role="radio"
              aria-checked={policy === 'immediate'}
              onClick={() => setPolicy('immediate')}
            >
              {t('settings.machines.batchUpdate.immediate', 'Update now (interrupt conversations)')}
            </Button>
          </div>
        ) : null}
        {step === 'confirm-immediate' ? (
          <p role="alert" {...stylex.props(styles.warning)}>
            {t(
              'settings.machines.batchUpdate.confirmImmediate',
              '{{count}} running conversations will be interrupted. You can continue each one after the update.',
              { count: runningTotal }
            )}
          </p>
        ) : null}
        <Dialog.Footer>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {finished || step === 'running'
              ? t('common.close', 'Close')
              : t('common.cancel', 'Cancel')}
          </Button>
          {step !== 'running' ? (
            <Button
              variant={step === 'confirm-immediate' ? 'destructive' : 'primary'}
              disabled={probing || updatable.length === 0}
              onClick={confirm}
            >
              {step === 'confirm-immediate'
                ? t('settings.machines.batchUpdate.confirmInterrupt', 'Interrupt and update')
                : t('settings.machines.batchUpdate.start', 'Update {{count}} machines', {
                    count: updatable.length,
                  })}
            </Button>
          ) : null}
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
