import { collectClientDiagnostics } from '@/lib/client-diagnostics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { MachineId } from '@lody/shared';
import { bugReportDialogOpenAtom, currentWorkspaceIdAtom, userAtom } from '@/atoms';
import { runtimeAtom } from '@/atoms/runtime';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { withoutEncryptedSharedMachines } from '@/lib/visible-machine-index';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { readStoredAuthToken } from '@/lib/auth-bootstrap';
import { readChatLandingDefaults } from '@/lib/chat-landing-defaults';
import {
  attachClientDiagnostics,
  mintBugReportRequestToken,
  submitWebBugReport,
} from '@/lib/bug-report-api';
import { appendClientBuildInfo } from '@/lib/client-build-info';
import { buildClientLogUploadWithin, recordClientLog } from '@/lib/client-log';
import {
  BugReportDialog,
  type BugReportMachineOption,
  type BugReportSubmitState,
} from './bug-report-dialog';

const CLIENT_LOG_UPLOAD_WAIT_MS = 5000;

type PendingReport = {
  workspaceId: string;
  reporterUserId: string;
  bugReportId: string;
  diagnostics: string;
  withLogs: boolean;
};

export function BugReportDialogContainer() {
  const { t } = useTranslation();
  const [open, setOpen] = useAtom(bugReportDialogOpenAtom);
  // Same machine source as the chat landing picker / sidebar: includes
  // machines shared with the team, not just the ones whose meta rooms this
  // client happens to have cached.
  const visibleMachineIndex = useVisibleMachineMetas();
  // Log collection uses ordinary machine RPC, which encrypted shared machines never offer.
  const visibleMachines = useMemo(
    () => withoutEncryptedSharedMachines(visibleMachineIndex.machines, visibleMachineIndex),
    [visibleMachineIndex]
  );
  const onlineMachineIds = useOnlineMachineIds();
  const user = useAtomValue(userAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const runtime = useAtomValue(runtimeAtom);
  const [state, setState] = useState<BugReportSubmitState>({ status: 'idle' });
  const pendingReport = useRef<PendingReport | null>(null);
  const submitting = useRef(false);
  const submissionGeneration = useRef(0);
  const attachment = useRef<AbortController | null>(null);

  const cancelSubmission = useCallback(() => {
    submissionGeneration.current += 1;
    submitting.current = false;
    const active = attachment.current;
    attachment.current = null;
    active?.abort();
    pendingReport.current = null;
  }, []);

  useEffect(() => {
    setState({ status: 'idle' });
    return cancelSubmission;
  }, [workspaceId, user?.id, cancelSubmission]);

  const uploadDiagnostics = useCallback(async (report: PendingReport) => {
    attachment.current?.abort();
    const controller = new AbortController();
    attachment.current = controller;
    pendingReport.current = report;
    const saved = {
      status: 'success' as const,
      bugReportId: report.bugReportId,
      withLogs: report.withLogs,
    };
    // The report is already durable. Optional diagnostics must never hold its ID
    // or dismissal hostage, including during a retry.
    setState({ ...saved, clientDiagnostics: 'uploading' });
    let attached = false;
    try {
      attached = (
        await attachClientDiagnostics({
          workspaceId: report.workspaceId,
          bugReportId: report.bugReportId,
          diagnostics: report.diagnostics,
          sessionToken: readStoredAuthToken() ?? '',
          signal: controller.signal,
        })
      ).ok;
    } catch {
      // A missing host capability must not undo an already-created report either.
    }
    if (attachment.current !== controller) return;
    attachment.current = null;
    if (attached) pendingReport.current = null;
    setState({ ...saved, clientDiagnostics: attached ? 'uploaded' : 'failed' });
  }, []);

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
  // client diagnostics only.
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
      if (submitting.current) return;
      submitting.current = true;
      const generation = ++submissionGeneration.current;
      const isCurrent = () => submissionGeneration.current === generation;
      setState({ status: 'submitting' });
      const finish = (bugReportId: string, withLogs: boolean) => {
        if (isCurrent())
          void uploadDiagnostics({
            workspaceId,
            reporterUserId,
            bugReportId,
            diagnostics,
            withLogs,
          });
      };
      let diagnostics: string;
      try {
        diagnostics = await collectClientDiagnostics();
        if (!isCurrent()) return;
        const reportDescription = appendClientBuildInfo(description);

        if (machineId == null) {
          const result = await submitWebBugReport({
            workspaceId,
            description: reportDescription,
            sessionToken: readStoredAuthToken() ?? '',
          });
          if (!isCurrent()) return;
          if (result.ok) {
            finish(result.bugReportId, false);
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
        if (!isCurrent()) return;
        if (!minted.ok) {
          setState({ status: 'error', message: minted.error });
          return;
        }
        recordClientLog('info', 'bug_report.submitting', undefined, { machineId });
        const clientLog = await buildClientLogUploadWithin(CLIENT_LOG_UPLOAD_WAIT_MS);
        if (!isCurrent()) return;
        const response = await runtime.requestMachineBugReport(
          machineId,
          {
            description: reportDescription,
            reporterUserId,
            requestToken: minted.requestToken,
            ...(clientLog ? { clientLog } : {}),
          },
          { timeoutMs: 120_000 }
        );
        if (!isCurrent()) return;
        if (response?.success && response.bugReportId) {
          finish(response.bugReportId, true);
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
      } catch (error) {
        if (isCurrent())
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
      } finally {
        if (isCurrent()) submitting.current = false;
      }
    },
    [runtime, t, user?.id, workspaceId, uploadDiagnostics]
  );

  const handleClose = useCallback(() => {
    cancelSubmission();
    setOpen(false);
    setState({ status: 'idle' });
  }, [setOpen, cancelSubmission]);

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
      onRetryClientDiagnostics={() => {
        const report = pendingReport.current;
        if (
          report &&
          !attachment.current &&
          report.workspaceId === workspaceId &&
          report.reporterUserId === user?.id
        )
          void uploadDiagnostics(report);
      }}
    />
  );
}
