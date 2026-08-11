import type { LocalProjectId, MachineId } from '@lody/shared';
import type { selectAndWriteLocalProject } from '@/lib/local-project-import';

type LocalProjectImportResult = Awaited<ReturnType<typeof selectAndWriteLocalProject>>;

export async function importSidebarLocalProject(args: {
  importProject: () => Promise<LocalProjectImportResult>;
  navigateToProject: (machineId: MachineId, localProjectId: LocalProjectId) => void;
}): Promise<void> {
  const result = await args.importProject();
  if (!result) return;

  args.navigateToProject(result.machineId, result.localProjectId);
}
