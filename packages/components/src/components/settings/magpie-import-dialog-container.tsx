import { useState, useMemo } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  machineSupportsProtocolCapability,
  magpieProviderSettings,
  type MagpieTarget,
} from '@lody/shared';
import { pendingMagpieImportAtom, importMagpieProvidersAtom } from '@/atoms/magpie-import';
import { localMachineIdAtom, localCliStartingAtom } from '@/atoms/local-probe';
import { getMachineMetaMapAtom } from '@/atoms/machines';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import { toast } from '@/lib/toast';
import { MagpieImportDialog } from './magpie-import-dialog';
import { useMachineCatalogSettings } from '../../providers/machine-catalog-settings';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { useWorkspaceLocalAccountId } from '@/lib/e2ee-account';

export function MagpieImportDialogContainer() {
  const catalog = useMachineCatalogSettings();
  const scope = useResolvedWorkspaceScope();
  const accountId = useWorkspaceLocalAccountId();
  const [request, setRequest] = useAtom(pendingMagpieImportAtom);
  const importProviders = useSetAtom(importMagpieProvidersAtom);
  const machineId = useAtomValue(localMachineIdAtom);
  const starting = useAtomValue(localCliStartingAtom);
  const machines = useAtomValue(getMachineMetaMapAtom);
  const machine = machineId ? machines.get(machineId) : undefined;
  const ids = useMemo(() => (request && machineId ? [machineId] : []), [request, machineId]);
  useMachineFlockAgentConfigsForMachineIds(catalog ? [] : ids, { syncRemote: false });
  const { t } = useTranslation();
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const unavailable =
    catalog &&
    (!scope.enabled ||
      scope.workspaceId !== catalog.binding.workspaceId ||
      accountId !== catalog.binding.accountId)
      ? t('magpieImport.workspaceUnavailable', 'Wait for the current workspace before importing.')
      : !machineId ||
          starting ||
          (catalog && (typeof window === 'undefined' || window.__LODY_ELECTRON__ !== true))
        ? t('magpieImport.localUnavailable', 'Start the local agent to import Magpie.')
        : !machineSupportsProtocolCapability(machine, 'magpieImport') ||
            !machineSupportsProtocolCapability(machine, 'providerSetup')
          ? t('magpieImport.updateRequired', 'Update the local agent to import Magpie.')
          : undefined;
  const options = useMemo(
    () =>
      (request?.targets ?? []).map((id) => ({
        id,
        name: magpieProviderSettings(id, request?.gatewayUrl ?? 'http://127.0.0.1:3425').name,
        disabledReason:
          unavailable ??
          (id === 'pi' && !machineSupportsProtocolCapability(machine, 'builtinPi')
            ? t('magpieImport.piUnavailable', 'Pi is not supported on this machine.')
            : undefined),
      })),
    [request, unavailable, machine, t]
  );
  return (
    <MagpieImportDialog
      requestKey={request?.id}
      open={Boolean(request)}
      onOpenChange={(open) => {
        if (!open) setRequest(null);
      }}
      gatewayUrl={request?.gatewayUrl ?? ''}
      machineName={machine?.name}
      options={options}
      error={request && failure?.id === request.id ? failure.message : undefined}
      onImport={async (selected: MagpieTarget[]) => {
        if (!request) return;
        if (unavailable || !machineId) throw new Error(unavailable ?? 'Local machine unavailable');
        if (
          !selected.length ||
          new Set(selected).size !== selected.length ||
          selected.some((target) => !request.targets.includes(target))
        )
          throw new Error('Invalid Magpie selection');
        if (selected.includes('pi') && !machineSupportsProtocolCapability(machine, 'builtinPi'))
          throw new Error('This machine does not support Pi');
        setFailure(null);
        try {
          if (catalog) {
            await catalog.execute(machineId, {
              kind: 'import-magpie',
              request: { gatewayUrl: request.gatewayUrl, targets: selected },
            });
            setRequest((current) => (current?.id === request.id ? null : current));
          } else await importProviders({ requestId: request.id, targets: selected });
          toast.success(
            t('magpieImport.added', 'Magpie providers added. Check Providers for setup progress.')
          );
        } catch {
          const message = t(
            'magpieImport.failed',
            'Could not finish importing. Check the local agent and retry; providers already added will be kept.'
          );
          setFailure({ id: request.id, message });
          throw new Error(message);
        }
      }}
    />
  );
}
