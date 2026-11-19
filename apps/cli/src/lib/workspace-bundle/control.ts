import { formatErrorMessage } from '@/utils/format-error';
import type { WorkspaceBundleControlRequest, WorkspaceBundleControlResponse } from '@lody/shared';
import {
  runWorkspaceExport,
  runWorkspaceImport,
  type BundleActor,
  type BundleWorkspace,
} from './service';

export type WorkspaceBundleControlDeps = {
  workspace: BundleWorkspace;
  /** The daemon user's role in this workspace. */
  role: string;
  actor: BundleActor;
  journalDir: string;
};

/** Runs one daemon-side bundle request; failures become `{ ok: false }` replies. */
export async function handleWorkspaceBundleControl(
  request: WorkspaceBundleControlRequest,
  deps: WorkspaceBundleControlDeps
): Promise<WorkspaceBundleControlResponse> {
  try {
    if (request.operation === 'export') {
      const result = await runWorkspaceExport({
        workspace: deps.workspace,
        role: deps.role,
        actor: deps.actor,
        out: request.out,
      });
      return { ok: true, result };
    }
    const result = await runWorkspaceImport({
      workspace: deps.workspace,
      role: deps.role,
      actor: deps.actor,
      file: request.file,
      journalDir: deps.journalDir,
      ...(request.dryRun ? { dryRun: true } : {}),
    });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: formatErrorMessage(error) };
  }
}
