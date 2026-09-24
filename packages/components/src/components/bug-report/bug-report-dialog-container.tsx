import { useCallback, useMemo, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { MachineId } from '@lody/shared';
import { bugReportDialogOpenAtom, currentWorkspaceIdAtom, userAtom } from '@/atoms';
import { runtimeAtom } from '@/atoms/runtime';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { readStoredAuthToken } from '@/lib/auth-bootstrap';
import { readChatLandingDefaults } from '@/lib/chat-landing-defaults';
import { mintBugReportRequestToken, submitWebBugReport } from '@/lib/bug-report-api';
import { appendClientBuildInfo } from '@/lib/client-build-info';
import {
  BugReportDialog,
  type BugReportMachineOption,
  type BugReportSubmitState,
} from './bug-report-dialog';

export function BugReportDialogContainer() {
  const { t } = useTranslation();
  const [open, setOpen] = useAtom(bugReportDialogOpenAtom);
  // Same machine source as the chat landing picker / sidebar: includes
  // machines shared with the team, not just the ones whose meta rooms this
  // client happens to have cached.
  const { machines: visibleMachines } = useVisibleMachineMetas();
  const onlineMachineIds = useOnlineMachineIds();
  const user = useAtomValue(userAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const runtime = useAtomValue(runtimeAtom);
  const [state, setState] = useState<BugReportSubmitState>({ status: 'idle' });

  // Offline machines cannot answer the log-upload RPC, so they are not listed.
  const machines = useMemo<BugReportMachineOption[]>(() => {
    const options: BugReportMachineOption[] = [];
    for (const [id, meta] of visibleMachines) {
      if (!onlineMachineIds.has(id)) continue;
      options.push({ id, name: meta.name || id });
    }
    return options.sort((a, b) => a.name.localeCompare(b.name));
  }, [visibleMachines, onlineMachineIds]);

  // Preselect the user's most recently used machine (the chat-landing default
  // persisted per workspace) when it is online; otherwise fall back to any
  // online machine. With no online machine the report defaults to
  // description-only.
  const initialMachineId = useMemo<MachineId | null>(() => {
    if (machines.length === 0) {
      return null;
    }
    const lastUsedMachineId = readChatLandingDefaults(workspaceId)?.machineId ?? null;
    const lastUsed = machines.find((machine) => machine.id === lastUsedMachineId);
    return (lastUsed ?? machines[0])?.id ?? null;
  }, [machines, workspaceId]);

  const handleSubmit = useCallback(
    async ({ machineId, description }: { machineId: MachineId | null; description: string }) => {
      const reporterUserId = user?.id;
      if (!reporterUserId || !workspaceId) {
        setState({
          status: 'error',
          message: t('bugReport.notReady', 'Workspace connection is not ready yet.'),
        });
        return;
      }
      setState({ status: 'submitting' });
      const reportDescription = appendClientBuildInfo(description);

      if (machineId == null) {
        const result = await submitWebBugReport({
          workspaceId,
          description: reportDescription,
          sessionToken: readStoredAuthToken() ?? '',
        });
        if (result.ok) {
          setState({ status: 'success', bugReportId: result.bugReportId, withLogs: false });
        } else {
          setState({ status: 'error', message: result.error });
        }
        return;
      }

      if (!runtime) {
        setState({
          status: 'error',
          message: t('bugReport.notReady', 'Workspace connection is not ready yet.'),
        });
        return;
      }
      const minted = await mintBugReportRequestToken({
        workspaceId,
        machineId,
        sessionToken: readStoredAuthToken() ?? '',
      });
      if (!minted.ok) {
        setState({ status: 'error', message: minted.error });
        return;
      }
      const response = await runtime.requestMachineBugReport(
        machineId,
        { description: reportDescription, reporterUserId, requestToken: minted.requestToken },
        { timeoutMs: 120_000 }
      );
      if (response?.success && response.bugReportId) {
        setState({ status: 'success', bugReportId: response.bugReportId, withLogs: true });
        return;
      }
      setState({
        status: 'error',
        message:
          response?.error ??
          t(
            'bugReport.timeoutError',
            'The machine did not respond. Make sure it is online and try again.'
          ),
      });
    },
    [runtime, t, user?.id, workspaceId]
  );

  const handleClose = useCallback(() => {
    setOpen(false);
    setState({ status: 'idle' });
  }, [setOpen]);

  return (
    <BugReportDialog
      open={open}
      machines={machines}
      initialMachineId={initialMachineId}
      state={state}
      onSubmit={(args) => {
        void handleSubmit(args);
      }}
      onClose={handleClose}
    />
  );
}
