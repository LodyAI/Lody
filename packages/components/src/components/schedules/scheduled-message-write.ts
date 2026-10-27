import {
  ScheduleRepository,
  ScheduledMessageSchema,
  getServerNow,
  type ScheduleDraft,
  type ScheduledMessage,
  type SessionId,
  type MachineId,
  type SessionInputBlock,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import { prepareDraftAttachments } from '@/lib/session-attachment-preparation';

/** Use the same owned attachment transfers as Send, without publishing a user turn. */
export async function prepareScheduledMessage(args: {
  runtime: WorkspaceRuntime;
  sessionId: SessionId;
  machineId: MachineId;
  actorId: string;
  inputBlocks: SessionInputBlock[];
  attachments: SessionAttachmentDraft[];
  message?: Omit<ScheduledMessage, 'inputBlocks'>;
  token: string | null;
  localMachineId: MachineId | null;
  signal: AbortSignal;
  onAttachments: (attachments: SessionAttachmentDraft[]) => void;
}): Promise<ScheduledMessage> {
  if (args.runtime.contentMode === 'e2ee') throw new Error('e2ee_feature_unavailable');
  let attachments = args.attachments;
  const prepared = await prepareDraftAttachments({
    content: { mode: 'plaintext' },
    resources: args.runtime.sendResources,
    signal: args.signal,
    token: () => args.token,
    localMachineId: () => args.localMachineId,
    record: {
      workspaceId: args.runtime.workspaceId,
      sessionId: args.sessionId,
      targetMachineId: args.machineId,
      attachments,
      entry: {
        id: 'scheduled-draft',
        role: 'user',
        userId: args.actorId,
        timestamp: new Date(getServerNow()).toISOString(),
        items: [],
        finished: true,
        fileDiff: [],
        inputConfig: { inputBlocks: args.inputBlocks },
      },
    },
    update: (next) => {
      attachments = next;
      args.onAttachments(next);
    },
    report: (id, progress) =>
      args.onAttachments(
        attachments.map((item) => (item.id === id ? { ...item, progress } : item))
      ),
  });
  return ScheduledMessageSchema.parse({
    ...args.message,
    inputBlocks: prepared.entry.inputConfig?.inputBlocks,
  });
}

/** Stable identity is supplied by the draft, including after an uncertain save. */
export async function saveScheduledMessage(args: {
  runtime: WorkspaceRuntime;
  actorId: string;
  scheduleId: string;
  activationId: string;
  activityId: string;
  draft: ScheduleDraft;
  create: boolean;
  now?: number;
}) {
  const now = args.now ?? getServerNow();
  if (args.runtime.contentMode === 'e2ee') throw new Error('e2ee_feature_unavailable');
  if (args.draft.trigger.kind !== 'once' || Date.parse(args.draft.trigger.at) <= now)
    throw new Error('SCHEDULE_TIME_PASSED');
  return args.runtime.withScheduleStore(
    args.scheduleId,
    () =>
      new ScheduleRepository(args.runtime.repo, args.runtime.workspaceId).save({ ...args, now }),
    { create: args.create }
  );
}
