import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { MachineId } from '@lody/shared';
import type { ProjectMemberSourceOption } from '@/lib/project-member-sources';

const MAX_NAMED_MACHINES = 3;

/**
 * How the editor names machines and where a repository can run: this
 * machine is "This machine" and comes first, a repository lists the machines
 * holding a copy (a few by name, then a count), and one only on GitHub says so.
 */
export function useProjectMemberSourceNames(
  sources: readonly ProjectMemberSourceOption[],
  currentMachineId: MachineId | null
) {
  const { t } = useTranslation();
  const machineNames = useMemo(() => {
    const names = new Map<MachineId, string>();
    for (const option of sources) {
      for (const copy of option.copies) names.set(copy.machineId, copy.machineName);
    }
    return names;
  }, [sources]);
  const machineName = (machineId: MachineId) =>
    machineId === currentMachineId
      ? t('settings.projectGroups.picker.thisMachine')
      : (machineNames.get(machineId) ?? machineId);
  const machinesOf = (option: Pick<ProjectMemberSourceOption, 'copies'>) => {
    if (option.copies.length === 0) return t('settings.projectGroups.picker.githubOnly');
    const names = [...option.copies]
      .sort((left, right) =>
        left.machineId === currentMachineId ? -1 : right.machineId === currentMachineId ? 1 : 0
      )
      .map((copy) => machineName(copy.machineId));
    const shown = names.slice(0, MAX_NAMED_MACHINES).join(' · ');
    return names.length > MAX_NAMED_MACHINES
      ? t('settings.projectGroups.picker.moreMachines', {
          machines: shown,
          count: names.length - MAX_NAMED_MACHINES,
        })
      : shown;
  };
  return { machineName, machinesOf };
}
