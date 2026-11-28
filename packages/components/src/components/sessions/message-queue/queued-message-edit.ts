import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import {
  normalizeSessionInputBlocks,
  type AcpConfigOptionValue,
  type AgentRoleId,
  type MessageQueueItem,
  type SessionInputBlock,
} from '@lody/shared';
import { queueTask } from './queue-task';
import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import { QUEUED_EDIT_RENEW_INTERVAL_MS } from '@/lib/queued-edit-lease';

export { QUEUED_EDIT_RENEW_INTERVAL_MS };

/** One composer edit of a queued message. In memory, per Session, like composer drafts. */
export type QueuedMessageEditState = {
  cid: string;
  /** The row as it was when the edit started; "unchanged" is measured against it. */
  original: MessageQueueItem;
  /** Text loaded into the composer. */
  text: string;
  /** Non-text input the edit still carries (images, files, references), in their order. */
  keptBlocks: SessionInputBlock[];
};

export const queuedMessageEditAtomFamily = atomFamily((_sessionId: string) =>
  atom<QueuedMessageEditState | undefined>(undefined)
);

export function queuedInputBlocksOf(item: MessageQueueItem): SessionInputBlock[] {
  return normalizeSessionInputBlocks(
    item.acpSessionConfig?.inputBlocks,
    item.acpSessionConfig?.prompt ?? (item.acpSessionConfig ? '' : item.task)
  );
}

function textOf(blocks: readonly SessionInputBlock[]): string {
  return blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n\n')
    .trim();
}

export function beginQueuedMessageEdit(item: MessageQueueItem): QueuedMessageEditState {
  const blocks = queuedInputBlocksOf(item);
  return {
    cid: item.$cid,
    original: item,
    text: textOf(blocks),
    keptBlocks: blocks.filter((block) => block.type !== 'text'),
  };
}

/** The run configuration a queued message carries, in comparable form. */
export type QueuedRunConfig = {
  modeId: string | null;
  modelId: string | null;
  configOptionValues: Record<string, AcpConfigOptionValue>;
  /** Undefined: no Role recorded (legacy); null: explicit None. */
  agentRoleId: AgentRoleId | null | undefined;
};

export function queuedRunConfigOf(item: MessageQueueItem): QueuedRunConfig {
  const config = item.acpSessionConfig;
  return {
    modeId: config?.modeId ?? null,
    modelId: config?.modelId ?? null,
    configOptionValues: (config?.configOptionValues ?? {}) as Record<string, AcpConfigOptionValue>,
    agentRoleId: config?.agentRoleId as AgentRoleId | null | undefined,
  };
}

function sameValues(
  left: Record<string, AcpConfigOptionValue>,
  right: Record<string, AcpConfigOptionValue>
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (left[key] !== right[key]) return false;
  return true;
}

/** A Role recorded as absent and an explicit None both mean "no Role" here. */
export function queuedRunConfigEquals(left: QueuedRunConfig, right: QueuedRunConfig): boolean {
  return (
    left.modeId === right.modeId &&
    left.modelId === right.modelId &&
    (left.agentRoleId ?? null) === (right.agentRoleId ?? null) &&
    sameValues(left.configOptionValues, right.configOptionValues)
  );
}

/**
 * Which fields of a queued row differ from the composer's current selection.
 * A field the row never recorded follows the Session default, so it never
 * differs.
 */
export function queuedRunConfigDifferences(
  item: QueuedRunConfig,
  current: QueuedRunConfig
): { model: boolean; mode: boolean; options: boolean; role: boolean } {
  return {
    model: item.modelId !== null && item.modelId !== current.modelId,
    mode: item.modeId !== null && item.modeId !== current.modeId,
    options: Object.entries(item.configOptionValues).some(
      ([key, value]) => current.configOptionValues[key] !== value
    ),
    role:
      item.agentRoleId !== undefined &&
      (item.agentRoleId ?? null) !== (current.agentRoleId ?? null),
  };
}

const stripSpans = (blocks: readonly SessionInputBlock[]) =>
  JSON.stringify(
    blocks.map((block) => {
      if (block.type !== 'text') return block;
      const { spans: _spans, ...rest } = block as SessionInputBlock & { spans?: unknown };
      return rest;
    })
  );

export type QueuedMessageEditSave = {
  edit: QueuedMessageEditState;
  /** What the composer produced: references and ready attachments plus its text. */
  composerBlocks: readonly SessionInputBlock[];
  /** Attachments added during the edit that still need preparation. */
  attachments: readonly SessionAttachmentDraft[];
  runConfig: QueuedRunConfig;
  /** The edit's run configuration as a fresh queued config, used only when it changed. */
  buildConfig: (
    inputBlocks: SessionInputBlock[]
  ) => NonNullable<MessageQueueItem['acpSessionConfig']>;
  editor: { userId: string; userName?: string };
};

export type QueuedMessageEditResult =
  | { kind: 'unchanged' }
  | { kind: 'empty' }
  | {
      kind: 'replace';
      /** Fields written over the live row in one replacement. */
      patch: Pick<
        MessageQueueItem,
        'task' | 'userId' | 'userName' | 'isEditing' | 'editingStartedAt' | 'acpSessionConfig'
      >;
      inputBlocks: SessionInputBlock[];
    };

/**
 * Decide what saving a composer edit writes. Saving an untouched edit is a
 * cancel: the author and signature stay. A real change replaces content and
 * configuration together and makes the editor the author (owner decision
 * 2026-11-27). An unchanged run configuration keeps the frozen Role revision.
 */
export function resolveQueuedMessageEdit(save: QueuedMessageEditSave): QueuedMessageEditResult {
  const { edit } = save;
  const original = edit.original;
  const originalBlocks = queuedInputBlocksOf(original);
  const originalText = textOf(originalBlocks);
  const composerText = textOf(save.composerBlocks);
  const textBlocks =
    composerText === originalText
      ? originalBlocks.filter((block) => block.type === 'text')
      : save.composerBlocks.filter((block) => block.type === 'text');
  const addedBlocks = save.composerBlocks.filter((block) => block.type !== 'text');
  const inputBlocks = [...edit.keptBlocks, ...addedBlocks, ...textBlocks];
  if (inputBlocks.length === 0 && save.attachments.length === 0) return { kind: 'empty' };

  const configUnchanged = queuedRunConfigEquals(save.runConfig, queuedRunConfigOf(original));
  const contentUnchanged =
    save.attachments.length === 0 &&
    addedBlocks.length === 0 &&
    composerText === originalText &&
    stripSpans(edit.keptBlocks) ===
      stripSpans(originalBlocks.filter((block) => block.type !== 'text'));
  if (configUnchanged && contentUnchanged) return { kind: 'unchanged' };

  const prompt = textOf(textBlocks);
  const acpSessionConfig =
    configUnchanged && original.acpSessionConfig
      ? {
          ...original.acpSessionConfig,
          prompt,
          inputBlocks: inputBlocks.length > 0 ? inputBlocks : undefined,
        }
      : save.buildConfig(inputBlocks);
  return {
    kind: 'replace',
    inputBlocks,
    patch: {
      task: queueTask(inputBlocks, save.attachments),
      userId: save.editor.userId,
      userName: save.editor.userName,
      isEditing: false,
      editingStartedAt: undefined,
      acpSessionConfig,
    },
  };
}

/** True when this device should refresh the row's editing lease now. */
export function queuedEditLeaseNeedsRenewal(
  item: Pick<MessageQueueItem, 'isEditing' | 'editingStartedAt'>,
  now: number
): boolean {
  if (!item.isEditing) return true;
  const startedAt = item.editingStartedAt ?? 0;
  return now - startedAt >= QUEUED_EDIT_RENEW_INTERVAL_MS;
}
