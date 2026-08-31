import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { toast } from 'sonner';
import {
  type LocalProjectControlResponse,
  type LocalProjectId,
  type MachineId,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { useIsMobile } from '@/hooks/use-mobile';
import { useOrganization } from '@/hooks/useOrganization';
import { prepareAndWriteLocalProject } from '@/lib/local-project-import';
import {
  AddLocalProjectDialog,
  type AddLocalProjectDialogProps,
  type RemoteDirectoryOpResult,
  type RemoteDirectoryOps,
  type RemoteDirectoryPickerMachine,
} from './add-local-project-dialog';
import { buildAddLocalProjectMachineOptions } from './local-project-machine-options';

function normalizeResponse<T>(
  response: LocalProjectControlResponse | null,
  expectedType: string,
  timeoutMessage: string
): RemoteDirectoryOpResult<T> {
  if (!response) {
    return { ok: false, errorCode: 'timeout', message: timeoutMessage };
  }
  if (!response.ok) {
    return { ok: false, errorCode: response.error, message: response.message };
  }
  if (response.type !== expectedType) {
    return { ok: false, message: `Unexpected response: ${response.type}` };
  }
  // Result shape is validated on the wire by the RPC client's zod schema and is
  // discriminated by `type`, so the cast is safe at this boundary.
  return { ok: true, value: response.result as T };
}

/**
 * Workspace-visible machines annotated with whether the current user may add
 * folders to them. Ownership is a UI-only control today: teammate rows remain
 * visible for context, but the picker never sends browse or add RPCs for them.
 * Workspace Machine RPC does not authenticate a caller-supplied user id, so
 * this guard must not be described as defense-in-depth. Exported on its own so
 * surfaces that need the addable set without the picker's RPC wiring (the
 * Projects settings page) resolve it through the same rule as the dialog.
 */
export function useAddLocalProjectMachines(): {
  machines: RemoteDirectoryPickerMachine[];
  machinesLoading: boolean;
} {
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  const localMachineId = useAtomValue(localMachineIdAtom);
  const { activeOrganization } = useOrganization();
  const { machines: visibleMachines, accessByMachineId } = useVisibleMachineMetas();
  const onlineMachineIds = useOnlineMachineIds();
  const ownerNameByUserId = useMemo(() => {
    const names = new Map<string, string>();
    for (const member of activeOrganization?.members ?? []) {
      names.set(member.userId, member.user?.name || member.user?.email || member.userId);
    }
    return names;
  }, [activeOrganization?.members]);

  const machines = useMemo<RemoteDirectoryPickerMachine[]>(
    () =>
      buildAddLocalProjectMachineOptions({
        visibleMachines,
        accessByMachineId,
        onlineMachineIds,
        localMachineId,
        currentUserId,
        ownerNameByUserId,
      }),
    [
      visibleMachines,
      accessByMachineId,
      onlineMachineIds,
      localMachineId,
      currentUserId,
      ownerNameByUserId,
    ]
  );

  return { machines, machinesLoading: currentUserId === null };
}

/**
 * Pairs the addable machine list with the RPC-backed directory operations for
 * the picker. Kept as a hook so the pure `AddLocalProjectDialog` stays
 * Storybook-friendly with injected fakes.
 */
export function useAddLocalProjectController(
  onProjectAdded?: AddLocalProjectDialogProps['onAdded'],
  onProjectLocated?: (info: { machineId: MachineId; localProjectId: LocalProjectId }) => void
) {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { activeOrganization } = useOrganization();
  const { machines, machinesLoading } = useAddLocalProjectMachines();

  const ops = useMemo<RemoteDirectoryOps>(() => {
    const timeoutMessage = t('localProjects.add.timeout', 'The machine did not respond in time.');
    return {
      listRoots: async (machineId) =>
        normalizeResponse(
          (await runtime?.requestLocalProjectControl(
            { type: 'local-project/list-roots', machineId },
            { timeoutMs: 15_000 }
          )) ?? null,
          'local-project/list-roots',
          timeoutMessage
        ),
      browseDir: async (machineId, args) =>
        normalizeResponse(
          (await runtime?.requestLocalProjectControl(
            {
              type: 'local-project/browse-dir',
              machineId,
              workspaceId: runtime?.workspaceId,
              absolutePath: args.absolutePath,
              cursor: args.cursor,
            },
            { timeoutMs: 30_000 }
          )) ?? null,
          'local-project/browse-dir',
          timeoutMessage
        ),
      addProject: async (machineId, args) => {
        if (!runtime) {
          return { ok: false, errorCode: 'timeout', message: timeoutMessage };
        }
        try {
          return {
            ok: true,
            value: await prepareAndWriteLocalProject({
              runtime,
              machineId,
              rootPath: args.rootPath,
              timeoutMessage,
            }),
          };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      },
    };
  }, [runtime, t]);

  const onAdded = useCallback<AddLocalProjectDialogProps['onAdded']>(
    (info) => {
      toast.success(t('localProjects.add.addedToast', 'Added “{{name}}”', { name: info.name }), {
        description:
          (activeOrganization?.members.length ?? 0) > 1
            ? t(
                'localProjects.add.privateByDefault',
                'This project is private by default. Open project settings when you are ready to share it with the team.'
              )
            : undefined,
      });
      onProjectAdded?.(info);
    },
    [activeOrganization?.members.length, onProjectAdded, t]
  );

  const onLocateRegistered = useCallback<
    NonNullable<AddLocalProjectDialogProps['onLocateRegistered']>
  >(
    (machineId, localProjectId) => {
      toast.info(
        t('localProjects.add.alreadyAdded', 'This folder is already a project in this workspace.')
      );
      onProjectLocated?.({ machineId, localProjectId });
    },
    [onProjectLocated, t]
  );

  return {
    machines,
    machinesLoading,
    ops,
    onAdded,
    onLocateRegistered,
  };
}

export interface AddLocalProjectDialogContainerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMachineId?: MachineId | null;
  onAdded?: AddLocalProjectDialogProps['onAdded'];
  onLocated?: (info: { machineId: MachineId; localProjectId: LocalProjectId }) => void;
}

export function AddLocalProjectDialogContainer({
  open,
  onOpenChange,
  initialMachineId,
  onAdded,
  onLocated,
}: AddLocalProjectDialogContainerProps) {
  const isMobile = useIsMobile();
  const controller = useAddLocalProjectController(onAdded, onLocated);

  return (
    <AddLocalProjectDialog
      open={open}
      onOpenChange={onOpenChange}
      isMobile={isMobile}
      machines={controller.machines}
      machinesLoading={controller.machinesLoading}
      initialMachineId={initialMachineId}
      ops={controller.ops}
      onAdded={controller.onAdded}
      onLocateRegistered={controller.onLocateRegistered}
    />
  );
}
