import {
  ScheduleRepository,
  scheduleDefinitionFingerprint,
  type SessionId,
  type WorkspaceId,
  type ScheduleRepositoryPort,
} from '@lody/shared';

/** A published reservation owns its local bytes even before it has a history entry. */
export async function isScheduledMessageFile(args: {
  repo: ScheduleRepositoryPort;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  fileId: string;
}): Promise<boolean> {
  const repository = new ScheduleRepository(args.repo, args.workspaceId);
  for (const row of await repository.list()) {
    if (
      !row.scheduledMessage ||
      row.destination.kind !== 'existing_session' ||
      row.destination.sessionId !== args.sessionId
    )
      continue;
    const document = await repository.read(row.scheduleId);
    // An incompletely synced reservation is not evidence that its bytes are abandoned.
    if (!document || scheduleDefinitionFingerprint(document) !== row.definitionFingerprint)
      throw new Error('Scheduled attachment reservation is not ready');
    if (
      document.message?.inputBlocks.some(
        (block) =>
          block.type === 'file' && block.transport === 'local' && block.fileId === args.fileId
      )
    )
      return true;
  }
  return false;
}
