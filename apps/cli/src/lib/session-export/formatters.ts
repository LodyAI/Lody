import path from 'node:path';
import type { MessageContent, SessionHistoryInput, SessionMeta } from '@lody/shared';
import type {
  ExportAttachmentRecord,
  ExportPlanRecord,
  ExportSessionArtifacts,
  ExportSessionSummary,
  ExportSystemNoticeRecord,
  ExportToolCallRecord,
  ExportTranscriptTurn,
} from './types';
import { encodeExportPathSegment } from './path-utils';

const BUILTIN_AGENT_TYPE_LABELS: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
};

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function normalizeString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function cloneItems(items: SessionHistoryInput['items']): MessageContent[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item) => sanitizeTranscriptItem(structuredClone(item as MessageContent)));
}

function sanitizeTranscriptItem(item: MessageContent): MessageContent {
  if (item.type !== 'tool_call') {
    return item;
  }

  return {
    ...item,
    content: (item.content ?? []).filter(
      (content): content is Exclude<NonNullable<typeof item.content>[number], { type: 'diff' }> =>
        content.type !== 'diff'
    ),
  };
}

function buildAttachmentFileName(image: Extract<MessageContent, { type: 'image' }>): string {
  const extension =
    (image.fileName ? path.extname(image.fileName).trim() : '') ||
    MIME_EXTENSION_MAP[image.mimeType] ||
    '';
  return `${encodeExportPathSegment(image.imageId, 'image')}${extension}`;
}

function buildAttachmentRelativePath(image: Extract<MessageContent, { type: 'image' }>): string {
  return path.posix.join('artifacts', 'attachments', 'files', buildAttachmentFileName(image));
}

function appendAttachment(
  attachments: Map<string, ExportAttachmentRecord>,
  turnId: string,
  image: Extract<MessageContent, { type: 'image' }>
): void {
  const existing = attachments.get(image.imageId);
  if (existing) {
    if (!existing.sourceTurnIds.includes(turnId)) {
      existing.sourceTurnIds.push(turnId);
    }
    return;
  }

  attachments.set(image.imageId, {
    imageId: image.imageId,
    mimeType: image.mimeType,
    fileName: buildAttachmentFileName(image),
    originalFileName: normalizeString(image.fileName),
    sizeBytes: image.sizeBytes,
    width: typeof image.width === 'number' ? image.width : null,
    height: typeof image.height === 'number' ? image.height : null,
    sourceTurnIds: [turnId],
    relativePath: buildAttachmentRelativePath(image),
  });
}

export function toUserFacingAgentType(session: Pick<SessionMeta, 'cliType' | 'agentType'>): string {
  if (session.cliType === 'builtin') {
    return BUILTIN_AGENT_TYPE_LABELS[session.agentType] ?? session.agentType;
  }
  return session.agentType;
}

export function toExportSessionSummary(
  session: SessionMeta,
  workspaceId: string
): ExportSessionSummary {
  return {
    sessionId: session.id,
    title: normalizeString(session.title),
    createdAt: session.createdAt,
    status: session.status ?? null,
    archived: session.isArchived === true,
    workspaceId,
    agent: {
      type: toUserFacingAgentType(session),
    },
    project: session.project,
    repoFullName: normalizeString(session.repoFullName),
    baseBranch: normalizeString(session.baseBranch),
    branchName: normalizeString(session.branchName),
  };
}

export function buildSessionArtifacts(history: SessionHistoryInput[]): ExportSessionArtifacts {
  const transcript: ExportTranscriptTurn[] = [];
  const plans: ExportPlanRecord[] = [];
  const toolCalls: ExportToolCallRecord[] = [];
  const systemNotices: ExportSystemNoticeRecord[] = [];
  const attachments = new Map<string, ExportAttachmentRecord>();

  for (const entry of history) {
    const items = cloneItems(entry.items);
    transcript.push({
      turnId: entry.id,
      role: entry.role,
      timestamp: entry.timestamp,
      finished: typeof entry.finished === 'boolean' ? entry.finished : null,
      sendStatus: entry.sendStatus,
      startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : null,
      endedAt: typeof entry.endedAt === 'number' ? entry.endedAt : null,
      modelInfo: entry.modelInfo,
      items,
    });

    if (Array.isArray(entry.plan) && entry.plan.length > 0) {
      plans.push({
        turnId: entry.id,
        timestamp: entry.timestamp,
        entries: structuredClone(entry.plan),
      });
    }

    for (const item of items) {
      if (item.type === 'image') {
        appendAttachment(attachments, entry.id, item);
        continue;
      }

      if (item.type === 'image_group') {
        for (const image of item.images) {
          appendAttachment(attachments, entry.id, { type: 'image', ...image });
        }
        continue;
      }

      if (item.type === 'tool_call') {
        toolCalls.push({
          turnId: entry.id,
          timestamp: entry.timestamp,
          role: entry.role,
          toolCallId: item.toolCallId,
          title: normalizeString(item.title),
          kind: normalizeString(item.kind),
          status: item.status,
          locations: item.locations,
          permissionRequest: item.permissionRequest,
          content: (item.content ?? []).filter(
            (
              content
            ): content is Exclude<NonNullable<typeof item.content>[number], { type: 'diff' }> =>
              content.type !== 'diff'
          ),
          rawInput: item.rawInput,
          rawOutput: item.rawOutput,
        });
        continue;
      }

      if (item.type === 'system_notice') {
        systemNotices.push({
          turnId: entry.id,
          timestamp: entry.timestamp,
          role: entry.role,
          name: item.name,
          meta: item.meta,
        });
      }
    }
  }

  return {
    transcript,
    plans,
    toolCalls,
    systemNotices,
    attachments: [...attachments.values()].sort((left, right) =>
      left.imageId.localeCompare(right.imageId)
    ),
  };
}
