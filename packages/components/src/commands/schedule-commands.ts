import {
  getMachineRoomId,
  getServerNow,
  machineSupportsSchedulesProtocol,
  type MachineId,
} from '@lody/shared';
import { scheduleCommandInputs as inputs } from '@lody/shared/commands/host-commands';
import type { WorkspaceRuntime } from '../atoms/runtime';
export async function executeScheduleCommand(
  runtime: WorkspaceRuntime,
  id: keyof typeof inputs,
  input: unknown,
  machineId: string,
  projectId: string | undefined,
  actor: string,
  check: () => void
) {
  await runtime.waitForContentAdmission?.();
  check();
  const args = inputs[id].parse(input);
  const enabled =
    id === 'scheduleSetEnabled' ? inputs.scheduleSetEnabled.parse(input).enabled : undefined;
  const { ScheduleRepository } = await import('@lody/shared/schedule-repository');
  const repository = new ScheduleRepository(runtime.repo, runtime.workspaceId, {
    protectedContent: runtime.contentMode === 'e2ee',
    signDeclaration: runtime.signScheduleDeclaration,
  });
  return runtime.withScheduleStore(args.scheduleId, async () => {
    const doc = await repository.read(args.scheduleId),
      def = doc?.definition;
    if (
      !def ||
      def.ownerId !== actor ||
      def.machineId !== machineId ||
      (projectId !== undefined &&
        projectId !==
          (def.project?.kind === 'local' ? def.project.localProjectId : def.project?.repoFullName))
    )
      throw Object.assign(Error('Schedule outside member installation'), { code: 'forbidden' });
    if (doc?.message || (id === 'scheduleRunNow' && def.trigger.kind === 'manual'))
      throw Error('Operation unavailable for schedule');
    if (id === 'scheduleRunNow' || enabled === true) {
      const machine = await runtime.repo.getDocMeta(getMachineRoomId(machineId as MachineId));
      if (!machineSupportsSchedulesProtocol(machine?.meta))
        throw Error('Machine schedule protocol unavailable');
    }
    check();
    const base = { scheduleId: args.scheduleId, actorId: actor, now: getServerNow() };
    if (enabled !== undefined)
      return repository.setEnabled({
        ...base,
        enabled,
        activationId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
      });
    await repository.requestRun({ ...base, manualRunId: crypto.randomUUID() });
    return {};
  });
}
