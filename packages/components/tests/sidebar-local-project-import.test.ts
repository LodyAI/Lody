import { describe, expect, it, vi } from 'vitest';
import type { LocalProjectId, MachineId } from '@lody/shared';
import { importSidebarLocalProject } from '../src/components/sidebar-local-project-import';

const machineId = 'machine-1' as MachineId;
const localProjectId = 'project-1' as LocalProjectId;

describe('importSidebarLocalProject', () => {
  it.each(['added', 'existing'] as const)(
    'navigates to a successfully %s local project',
    async (status) => {
      const navigateToProject = vi.fn();

      await importSidebarLocalProject({
        importProject: vi.fn(async () => ({
          status,
          machineId,
          localProjectId,
          name: 'lody',
          rootPath: '/repo/lody',
        })),
        navigateToProject,
      });

      expect(navigateToProject).toHaveBeenCalledOnce();
      expect(navigateToProject).toHaveBeenCalledWith(machineId, localProjectId);
    }
  );

  it('does not navigate when directory selection is cancelled', async () => {
    const navigateToProject = vi.fn();

    await importSidebarLocalProject({
      importProject: vi.fn(async () => null),
      navigateToProject,
    });

    expect(navigateToProject).not.toHaveBeenCalled();
  });

  it('preserves the import error and does not navigate', async () => {
    const navigateToProject = vi.fn();
    const error = new Error('Unable to add local project');

    await expect(
      importSidebarLocalProject({
        importProject: vi.fn(async () => {
          throw error;
        }),
        navigateToProject,
      })
    ).rejects.toBe(error);
    expect(navigateToProject).not.toHaveBeenCalled();
  });
});
