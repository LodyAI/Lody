import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import type { MachineId, MachineViewMeta } from '@lody/shared';
import { useConvexErrorMessage } from './use-convex-error-message';

export type MachineActionCallbacks = {
  onRename: (machineId: MachineId, newName: string) => Promise<void>;
  onDelete: (machine: MachineViewMeta) => Promise<void>;
  onSharedWithTeamChange?: (machineId: MachineId, sharedWithTeam: boolean) => Promise<void>;
  onPing?: (machineId: MachineId) => Promise<number>;
  onRestartDaemon?: (machineId: MachineId) => Promise<void>;
  onUpgradeDaemon?: (machineId: MachineId, targetVersion: string) => Promise<void>;
};

/**
 * Shared rename/share/delete/ping/restart/upgrade state + handlers for a single
 * machine, used by both the mobile `MachineDetailPane` and the desktop machine
 * accordion so the two surfaces don't reimplement the optimistic/toast logic.
 */
export function useMachineActionState({
  machine,
  sharedWithTeam,
  daemonUpdate,
  onRename,
  onDelete,
  onSharedWithTeamChange,
  onPing,
  onRestartDaemon,
  onUpgradeDaemon,
}: MachineActionCallbacks & {
  machine: MachineViewMeta;
  sharedWithTeam: boolean;
  daemonUpdate?: { currentVersion: string; latestVersion: string };
}) {
  const { t } = useTranslation();
  const getConvexErrorMessage = useConvexErrorMessage();

  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(machine.name);
  const [renameSaving, setRenameSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [optimisticShared, setOptimisticShared] = useState<boolean | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [pingLatencyMs, setPingLatencyMs] = useState<number | null>(null);
  const [restartingDaemon, setRestartingDaemon] = useState(false);
  const [upgradingDaemon, setUpgradingDaemon] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (optimisticShared !== null && optimisticShared === sharedWithTeam) {
      setOptimisticShared(null);
    }
  }, [optimisticShared, sharedWithTeam]);

  const commitRename = useCallback(async () => {
    const nextName = renameDraft.trim();
    setRenaming(false);
    if (!nextName || nextName === machine.name) {
      setRenameDraft(machine.name);
      return;
    }
    try {
      setRenameSaving(true);
      await onRename(machine.id, nextName);
    } catch (error) {
      setRenameDraft(machine.name);
      toast.error(t('workspace.machines.renameFailed', 'Failed to rename machine'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRenameSaving(false);
    }
  }, [renameDraft, machine.name, machine.id, onRename, t]);

  const handleSharedToggle = useCallback(
    async (checked: boolean) => {
      if (!onSharedWithTeamChange) return;
      setOptimisticShared(checked);
      try {
        setSharing(true);
        await onSharedWithTeamChange(machine.id, checked);
      } catch (error) {
        setOptimisticShared(null);
        toast.error(t('workspace.machines.shareFailed', 'Failed to update sharing'), {
          description: getConvexErrorMessage(error, 'Failed to update sharing'),
        });
      } finally {
        setSharing(false);
      }
    },
    [getConvexErrorMessage, machine.id, onSharedWithTeamChange, t]
  );

  const handleDelete = useCallback(async () => {
    try {
      setDeleting(true);
      await onDelete(machine);
      setDeleteOpen(false);
    } catch (error) {
      toast.error(t('workspace.machines.deleteFailed', 'Failed to delete machine'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDeleting(false);
    }
  }, [machine, onDelete, t]);

  const handlePing = useCallback(async () => {
    if (!onPing || pinging) return;
    try {
      setPinging(true);
      const latencyMs = await onPing(machine.id);
      setPingLatencyMs(latencyMs);
    } catch (error) {
      toast.error(t('settings.agent.machinePing.failed', 'Ping failed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPinging(false);
    }
  }, [machine.id, onPing, pinging, t]);

  const handleRestartDaemon = useCallback(async () => {
    if (!onRestartDaemon || restartingDaemon || upgradingDaemon) return;
    try {
      setRestartingDaemon(true);
      await onRestartDaemon(machine.id);
      toast.success(
        t('settings.agent.machineLifecycle.restartAccepted', 'Restart request accepted')
      );
    } catch (error) {
      toast.error(t('settings.agent.machineLifecycle.restartFailed', 'Restart request failed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRestartingDaemon(false);
    }
  }, [machine.id, onRestartDaemon, restartingDaemon, upgradingDaemon, t]);

  const handleUpgradeDaemon = useCallback(async () => {
    if (!onUpgradeDaemon || !daemonUpdate || restartingDaemon || upgradingDaemon) return;
    try {
      setUpgradingDaemon(true);
      await onUpgradeDaemon(machine.id, daemonUpdate.latestVersion);
      toast.success(
        t('settings.agent.machineLifecycle.upgradeAccepted', 'Update request accepted')
      );
    } catch (error) {
      toast.error(t('settings.agent.machineLifecycle.upgradeFailed', 'Update request failed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUpgradingDaemon(false);
    }
  }, [machine.id, onUpgradeDaemon, daemonUpdate, restartingDaemon, upgradingDaemon, t]);

  return {
    renaming,
    setRenaming,
    renameDraft,
    setRenameDraft,
    renameSaving,
    inputRef,
    commitRename,
    sharing,
    effectiveShared: optimisticShared ?? sharedWithTeam,
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
  };
}
