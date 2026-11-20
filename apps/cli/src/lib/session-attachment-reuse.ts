import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import path from 'node:path';
import {
  SESSION_FILE_MAX_COUNT,
  type LodyOperationCompletion,
  type MachineId,
  type MessageContent,
  type OperationCompletionContent,
  type SessionFilePayload,
  type SessionId,
  type SessionImagePayload,
  type WorkspaceId,
} from '@lody/shared';

export type AttachmentHistoryTurn = {
  readonly items?: readonly unknown[];
};
import { type SessionInputAttachment } from './session-input-content';
import { type SessionAttachmentTransfer } from './session-attachment-transfer';
import { ATTACHMENTS_DIR_RELATIVE, resolveContainedUploadPath } from './session-file-attachments';
import { prepareSessionInputAttachments } from './session-input-attachments';

export type ParsedAttachmentReference = {
  kind: 'image' | 'file';
  id: string;
};

const ATTACHMENT_REF_RE = /^(image|file):([A-Za-z0-9._-]+)$/;

export const parseAttachmentReference = (input: string): ParsedAttachmentReference | null => {
  const match = ATTACHMENT_REF_RE.exec(input.trim());
  if (!match) return null;
  return {
    kind: match[1] as 'image' | 'file',
    id: match[2]!,
  };
};

const toReusedImageBlock = (
  image: SessionImagePayload,
  ownerSessionId: SessionId
): Extract<SessionInputAttachment, { type: 'image' }> => ({
  type: 'image',
  imageId: image.imageId,
  ...(image.localImageId ? { localImageId: image.localImageId } : {}),
  ...(image.transport ? { transport: image.transport } : {}),
  ...(image.machineId ? { machineId: image.machineId } : {}),
  ...(image.encryption ? { encryption: image.encryption } : {}),
  mimeType: image.mimeType,
  ...(image.fileName ? { fileName: image.fileName } : {}),
  sizeBytes: image.sizeBytes,
  ...(image.width !== undefined ? { width: image.width } : {}),
  ...(image.height !== undefined ? { height: image.height } : {}),
  storageSessionId: image.storageSessionId ?? ownerSessionId,
});

const toReusedFileBlock = (
  file: SessionFilePayload,
  ownerSessionId: SessionId
): Extract<SessionInputAttachment, { type: 'file' }> => ({
  ...file,
  storageSessionId: file.storageSessionId ?? ownerSessionId,
});

const collectTurnAttachmentBlocks = (
  turn: AttachmentHistoryTurn,
  ownerSessionId: SessionId
): SessionInputAttachment[] => {
  const blocks: SessionInputAttachment[] = [];
  for (const rawItem of turn.items ?? []) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as MessageContent;
    if (item.type === 'image') {
      blocks.push(toReusedImageBlock(item, ownerSessionId));
    } else if (item.type === 'image_group') {
      for (const image of item.images) {
        blocks.push(toReusedImageBlock(image, ownerSessionId));
      }
    } else if (item.type === 'file') {
      blocks.push(toReusedFileBlock(item, ownerSessionId));
    } else if (item.type === 'coordinator_message') {
      for (const image of item.images ?? []) {
        blocks.push(toReusedImageBlock(image, ownerSessionId));
      }
      for (const file of item.files ?? []) {
        blocks.push(toReusedFileBlock(file, ownerSessionId));
      }
    }
  }
  return blocks;
};

const matchesReference = (
  block: SessionInputAttachment,
  ref: ParsedAttachmentReference
): boolean =>
  ref.kind === 'image'
    ? block.type === 'image' && block.imageId === ref.id
    : block.type === 'file' && block.fileId === ref.id;

const extractCompletionItems = (completion: LodyOperationCompletion) =>
  completion.type === 'result'
    ? completion.value.items
    : completion.type === 'cancelled'
      ? (completion.partial?.items ?? [])
      : [];

const iterOperationCompletions = (item: MessageContent): OperationCompletionContent[] => {
  if (item.type === 'operation_completion') return [item];
  if (item.type === 'operation_completion_batch') return item.members ?? [];
  return [];
};

const findDelegatedAttachmentSource = (
  history: readonly AttachmentHistoryTurn[],
  rawRef: string
): { targetSessionId: SessionId; assistantTurnId: string } | undefined => {
  for (let turnIndex = history.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = history[turnIndex];
    const items = turn?.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const rawItem = items[itemIndex];
      if (!rawItem || typeof rawItem !== 'object') continue;
      const completions = iterOperationCompletions(rawItem as MessageContent);
      for (let cIndex = completions.length - 1; cIndex >= 0; cIndex -= 1) {
        const opItems = extractCompletionItems(completions[cIndex]!.completion);
        for (let rIndex = opItems.length - 1; rIndex >= 0; rIndex -= 1) {
          const result = opItems[rIndex]!;
          if (
            result.status === 'succeeded' &&
            result.output?.attachments?.some((attachment) => attachment.ref === rawRef)
          ) {
            return {
              targetSessionId: result.target.sessionId,
              assistantTurnId: result.assistantTurnId,
            };
          }
        }
      }
    }
  }
  return undefined;
};

const isBlockTransportCompatible = (
  block: SessionInputAttachment,
  targetMachineId: MachineId | undefined
): boolean => {
  if (!targetMachineId) return true;
  if (block.transport !== 'local') return true;
  return block.machineId === targetMachineId;
};

const sha256File = async (filePath: string): Promise<string> => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex').toLowerCase();
};

const tryReuseMaterializedPath = async (args: {
  input: string;
  containWithin: string;
  callerSessionId: SessionId;
  callerHistory: readonly AttachmentHistoryTurn[];
  targetMachineId?: MachineId;
}): Promise<SessionInputAttachment | undefined> => {
  let absolutePath: string;
  let realContainWithin: string;
  try {
    absolutePath = await resolveContainedUploadPath(args.input, args.containWithin);
    realContainWithin = await fs.realpath(args.containWithin);
  } catch {
    return undefined;
  }
  const attachmentsRoot = path.join(realContainWithin, ATTACHMENTS_DIR_RELATIVE);
  const relative = path.relative(attachmentsRoot, absolutePath);
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    return undefined;
  }
  const attachmentPrefix = (id: string): string =>
    `${id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'file'}-`;

  let statSize: number;
  try {
    const handle = await fs.open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0) return undefined;
      statSize = stat.size;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }

  let computedSha256: string | undefined;
  for (let turnIndex = args.callerHistory.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const blocks = collectTurnAttachmentBlocks(
      args.callerHistory[turnIndex]!,
      args.callerSessionId
    );
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex]!;
      if (!isBlockTransportCompatible(block, args.targetMachineId)) continue;
      if (block.type === 'file') {
        if (!relative.startsWith(attachmentPrefix(block.fileId)) || block.sizeBytes !== statSize) {
          continue;
        }
        computedSha256 ??= await sha256File(absolutePath);
        if (computedSha256 === block.sha256.toLowerCase()) {
          return block;
        }
      } else {
        if (relative.startsWith(attachmentPrefix(block.imageId)) && block.sizeBytes === statSize) {
          return block;
        }
      }
    }
  }
  return undefined;
};

/**
 * Resolves attachment arguments using zero-copy cross-session `storageSessionId`
 * references whenever an entry refers to an attachment already stored in the
 * caller's history or in one of its delegated operation completion receipts.
 * Only genuinely new workspace file paths are snapshotted and uploaded.
 */
export async function resolveOrPrepareSessionAttachments(args: {
  inputs: readonly string[];
  cwd: string;
  containWithin?: string;
  workspaceId: WorkspaceId;
  callerSessionId: SessionId;
  targetSessionId: SessionId;
  sourceMachineId: MachineId;
  targetMachineId?: MachineId;
  relay?: SessionAttachmentTransfer;
  readCallerHistory: () => Promise<readonly AttachmentHistoryTurn[]>;
  readDelegatedTurn: (
    sessionId: SessionId,
    turnId: string
  ) => Promise<AttachmentHistoryTurn | undefined>;
}): Promise<SessionInputAttachment[]> {
  if (!args.inputs.length) return [];
  if (args.inputs.length > SESSION_FILE_MAX_COUNT) {
    throw new Error(`At most ${SESSION_FILE_MAX_COUNT} attachments are allowed`);
  }

  let cachedCallerHistory: readonly AttachmentHistoryTurn[] | undefined;
  const getCallerHistory = async () => {
    cachedCallerHistory ??= await args.readCallerHistory();
    return cachedCallerHistory;
  };

  const resolved = new Map<number, SessionInputAttachment>();
  const uploadEntries: Array<{ index: number; input: string }> = [];

  for (const [index, rawInput] of args.inputs.entries()) {
    const trimmed = rawInput.trim();
    if (!trimmed) throw new Error('Attachment path is empty');

    const ref = parseAttachmentReference(trimmed);
    if (ref) {
      const history = await getCallerHistory();
      let found: SessionInputAttachment | undefined;

      for (let turnIndex = history.length - 1; turnIndex >= 0 && !found; turnIndex -= 1) {
        const blocks = collectTurnAttachmentBlocks(history[turnIndex]!, args.callerSessionId);
        for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
          if (matchesReference(blocks[blockIndex]!, ref)) {
            found = blocks[blockIndex];
            break;
          }
        }
      }

      if (!found) {
        const delegated = findDelegatedAttachmentSource(history, trimmed);
        if (delegated) {
          const turn = await args.readDelegatedTurn(
            delegated.targetSessionId,
            delegated.assistantTurnId
          );
          if (turn) {
            const blocks = collectTurnAttachmentBlocks(turn, delegated.targetSessionId);
            found = blocks.find((block) => matchesReference(block, ref));
          }
        }
      }

      if (!found) {
        throw new Error(
          `Attachment reference not found in this conversation or its delegated results: ${trimmed}`
        );
      }
      if (!isBlockTransportCompatible(found, args.targetMachineId)) {
        throw new Error(
          `Local attachment ${trimmed} is stored only on machine ${found.machineId ?? 'unknown'} and cannot be forwarded to another machine before syncing`
        );
      }
      resolved.set(index, found);
      continue;
    }

    if (args.containWithin) {
      const history = await getCallerHistory();
      const reused = await tryReuseMaterializedPath({
        input: trimmed,
        containWithin: args.containWithin,
        callerSessionId: args.callerSessionId,
        callerHistory: history,
        targetMachineId: args.targetMachineId,
      });
      if (reused) {
        resolved.set(index, reused);
        continue;
      }
    }

    uploadEntries.push({ index, input: rawInput });
  }

  if (uploadEntries.length > 0) {
    const uploaded = await prepareSessionInputAttachments({
      paths: uploadEntries.map((entry) => entry.input),
      cwd: args.cwd,
      containWithin: args.containWithin,
      workspaceId: args.workspaceId,
      sessionId: args.targetSessionId,
      sourceMachineId: args.sourceMachineId,
      targetMachineId: args.targetMachineId ?? args.sourceMachineId,
      ...(args.relay ? { relay: args.relay } : {}),
    });
    uploadEntries.forEach((entry, uploadedIndex) => {
      resolved.set(entry.index, uploaded[uploadedIndex]!);
    });
  }

  return args.inputs.map((_, index) => resolved.get(index)!);
}
