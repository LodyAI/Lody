import { encodeSessionFilePath, type SessionFileRoot } from '@lody/shared';
import { resolveProjectFileTarget } from '@/session/worktree/project-member-access';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import type { ContentBlock } from '@agentclientprotocol/sdk';
import type {
  AcpSessionNotification,
  MessageContent,
  SessionFilePayload,
  SessionId,
  SessionImageUploadResponse,
  WorkspaceId,
} from '@lody/shared';
import {
  isTextPreviewable,
  SESSION_FILE_MAX_SIZE_BYTES,
  SESSION_FILE_PREVIEW_SNIFF_BYTES,
  SESSION_IMAGE_ALLOWED_MIME_TYPES,
  SESSION_IMAGE_MAX_SIZE_BYTES,
} from '@lody/shared';
import { v4 as uuidV4 } from 'uuid';

import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';
import { sanitizeAttachmentFileName } from '@/lib/session-file-attachments';

type UploadedACPAgentSessionImage = NonNullable<SessionImageUploadResponse['images']>[number];
type UploadedACPAgentSessionFile = SessionFilePayload & { downloadUrl: string };

export type ACPAgentUploadableImageFile = {
  absolutePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  bytes: Buffer;
};

export type ACPAgentValidatedUploadFile = {
  absolutePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  textPreview: boolean;
};

type MaterializeACPAgentRichContentOptions = {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  notification: AcpSessionNotification;
  logger: Pick<Logger, 'debug' | 'warn'>;
  resolveSessionFileRoots?: (sessionId: SessionId) => Promise<readonly SessionFileRoot[]>;
  resolveSessionWorkspaceRoot: (sessionId: SessionId) => string | null;
  validateSessionImageUploadPath: (filePath: string) => Promise<ACPAgentUploadableImageFile>;
  uploadSessionImageFile: (args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    file: ACPAgentUploadableImageFile;
  }) => Promise<UploadedACPAgentSessionImage>;
  validateSessionFileUploadPath: (
    filePath: string,
    options?: { containWithin?: string; fileRoots?: readonly SessionFileRoot[] }
  ) => Promise<ACPAgentValidatedUploadFile>;
  uploadValidatedSessionFile: (args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    file: ACPAgentValidatedUploadFile;
  }) => Promise<UploadedACPAgentSessionFile>;
};

const DEFAULT_ACP_FILE_MIME_TYPE = 'application/octet-stream';

const SESSION_IMAGE_MIME_TYPE_BY_EXTENSION: Record<
  string,
  (typeof SESSION_IMAGE_ALLOWED_MIME_TYPES)[number]
> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const SESSION_IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const ACP_FALLBACK_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'text/csv': 'csv',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
};

export const isACPAgentRichContentNotification = (
  notification: AcpSessionNotification
): boolean => {
  const update = notification.update;
  return update.sessionUpdate === 'agent_message_chunk' && update.content.type !== 'text';
};

const normalizeACPMimeType = (mimeType: string | null | undefined): string => {
  const normalized = mimeType?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : DEFAULT_ACP_FILE_MIME_TYPE;
};

const isSupportedSessionImageMimeType = (
  mimeType: string
): mimeType is (typeof SESSION_IMAGE_ALLOWED_MIME_TYPES)[number] =>
  (SESSION_IMAGE_ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);

const shouldUploadACPBytesAsImage = (mimeType: string, sizeBytes: number): boolean =>
  isSupportedSessionImageMimeType(mimeType) && sizeBytes <= SESSION_IMAGE_MAX_SIZE_BYTES;

const getACPFileNameFromUri = (uri: string | null | undefined): string | null => {
  const trimmed = uri?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'file:') {
      return path.basename(fileURLToPath(parsed));
    }
    if (parsed.pathname) {
      const decodedPathname = (() => {
        try {
          return decodeURIComponent(parsed.pathname);
        } catch {
          return parsed.pathname;
        }
      })();
      const baseName = path.basename(decodedPathname);
      return baseName && baseName !== '/' && baseName !== '.' ? baseName : null;
    }
    return null;
  } catch {
    const baseName = path.basename(trimmed);
    return baseName && baseName !== '/' && baseName !== '.' ? baseName : null;
  }
};

const buildACPContentFileName = (args: {
  preferredName?: string | null;
  uri?: string | null;
  fallbackStem: string;
  mimeType?: string | null;
}): string => {
  const mimeType = normalizeACPMimeType(args.mimeType);
  const fallbackExtension =
    ACP_FALLBACK_EXTENSION_BY_MIME_TYPE[mimeType] ??
    SESSION_IMAGE_EXTENSION_BY_MIME_TYPE[mimeType] ??
    null;
  const rawName = args.preferredName?.trim() || getACPFileNameFromUri(args.uri);
  const safeName = sanitizeAttachmentFileName(rawName || args.fallbackStem);
  if (path.extname(safeName)) {
    return safeName;
  }
  return fallbackExtension ? `${safeName}.${fallbackExtension}` : safeName;
};

const decodeACPBase64Data = (data: string, label: string): Buffer => {
  const trimmed = data.trim();
  const commaIndex = trimmed.startsWith('data:') ? trimmed.indexOf(',') : -1;
  const base64 = (commaIndex >= 0 ? trimmed.slice(commaIndex + 1) : trimmed).replace(/\s/g, '');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.byteLength <= 0) {
    throw new Error(`${label} is empty`);
  }
  return bytes;
};

const withTemporaryACPFile = async <T>(
  logger: Pick<Logger, 'debug'>,
  fileName: string,
  bytes: Buffer,
  fn: (absolutePath: string, fileName: string) => Promise<T>
): Promise<T> => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lody-acp-output-'));
  const safeFileName = sanitizeAttachmentFileName(fileName);
  const absolutePath = path.join(dir, safeFileName);
  try {
    await fs.promises.writeFile(absolutePath, bytes, { mode: 0o600 });
    return await fn(absolutePath, safeFileName);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch((error) => {
      logger.debug(
        `Failed to clean up temporary ACP output file ${dir}: ${formatErrorMessage(error)}`
      );
    });
  }
};

const uploadACPBytesAsSessionImage = async (
  options: MaterializeACPAgentRichContentOptions,
  args: {
    fileName: string;
    mimeType: string;
    bytes: Buffer;
  }
): Promise<UploadedACPAgentSessionImage> => {
  const mimeType = normalizeACPMimeType(args.mimeType);
  if (!isSupportedSessionImageMimeType(mimeType)) {
    throw new Error(`Unsupported image MIME type: ${mimeType}`);
  }
  if (args.bytes.byteLength <= 0) {
    throw new Error('Image is empty');
  }
  if (args.bytes.byteLength > SESSION_IMAGE_MAX_SIZE_BYTES) {
    throw new Error(
      `Image must be <= ${Math.floor(SESSION_IMAGE_MAX_SIZE_BYTES / (1024 * 1024))}MB`
    );
  }

  return await options.uploadSessionImageFile({
    workspaceId: options.workspaceId,
    sessionId: options.sessionId,
    file: {
      absolutePath: '',
      fileName: args.fileName,
      mimeType,
      sizeBytes: args.bytes.byteLength,
      bytes: args.bytes,
    },
  });
};

const uploadACPBytesAsSessionFile = async (
  options: MaterializeACPAgentRichContentOptions,
  args: {
    fileName: string;
    mimeType?: string | null;
    bytes: Buffer;
  }
): Promise<UploadedACPAgentSessionFile> => {
  const mimeType = normalizeACPMimeType(args.mimeType);
  if (args.bytes.byteLength <= 0) {
    throw new Error('File is empty');
  }
  if (args.bytes.byteLength > SESSION_FILE_MAX_SIZE_BYTES) {
    throw new Error(`File must be <= ${Math.floor(SESSION_FILE_MAX_SIZE_BYTES / (1024 * 1024))}MB`);
  }

  const sha256 = crypto.createHash('sha256').update(args.bytes).digest('hex');
  const sniffPrefix = args.bytes.subarray(0, SESSION_FILE_PREVIEW_SNIFF_BYTES);
  const textPreview = isTextPreviewable(args.fileName, mimeType, sniffPrefix);

  return await withTemporaryACPFile(
    options.logger,
    args.fileName,
    args.bytes,
    async (absolutePath, fileName) =>
      await options.uploadValidatedSessionFile({
        workspaceId: options.workspaceId,
        sessionId: options.sessionId,
        file: {
          absolutePath,
          fileName,
          mimeType,
          sizeBytes: args.bytes.byteLength,
          sha256,
          textPreview,
        },
      })
  );
};

const toImageGroupContent = (
  image: UploadedACPAgentSessionImage
): Extract<MessageContent, { type: 'image_group' }> => {
  const { downloadUrl: _downloadUrl, ...payload } = image;
  return {
    type: 'image_group',
    images: [payload],
  };
};

const toFileMessageContent = (
  file: UploadedACPAgentSessionFile
): Extract<MessageContent, { type: 'file' }> => {
  const { downloadUrl: _downloadUrl, ...payload } = file;
  return payload;
};

const buildACPAttachmentUploadFailureContent = (kind: string): MessageContent[] => [
  {
    type: 'text',
    text: `[Agent sent ${kind}, but Lody could not upload it for preview/download.]`,
  },
];

const materializeACPImageContent = async (
  options: MaterializeACPAgentRichContentOptions,
  content: Extract<ContentBlock, { type: 'image' }>
): Promise<MessageContent[]> => {
  const mimeType = normalizeACPMimeType(content.mimeType);
  const bytes = decodeACPBase64Data(content.data, 'ACP image');
  const fileName = buildACPContentFileName({
    uri: content.uri,
    fallbackStem: `agent-image-${uuidV4()}`,
    mimeType,
  });

  if (shouldUploadACPBytesAsImage(mimeType, bytes.byteLength)) {
    const uploaded = await uploadACPBytesAsSessionImage(options, {
      fileName,
      mimeType,
      bytes,
    });
    return [toImageGroupContent(uploaded)];
  }

  const uploaded = await uploadACPBytesAsSessionFile(options, {
    fileName,
    mimeType,
    bytes,
  });
  return [toFileMessageContent(uploaded)];
};

const resolveACPResourceLinkLocalPath = (uri: string): string | null => {
  const trimmed = uri.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'file:' ? fileURLToPath(parsed) : null;
  } catch {
    return trimmed;
  }
};

const shouldTreatACPPathAsImage = (filePath: string, mimeType: string): boolean => {
  if (isSupportedSessionImageMimeType(mimeType)) {
    return true;
  }
  const extension = path.extname(filePath).slice(1).trim().toLowerCase();
  return SESSION_IMAGE_MIME_TYPE_BY_EXTENSION[extension] !== undefined;
};

const materializeACPResourceLinkContent = async (
  options: MaterializeACPAgentRichContentOptions,
  content: Extract<ContentBlock, { type: 'resource_link' }>
): Promise<MessageContent[]> => {
  const localPath = resolveACPResourceLinkLocalPath(content.uri);
  if (!localPath) {
    const label = content.title?.trim() || content.name.trim() || content.uri;
    return [{ type: 'text', text: `[Agent shared a resource link: ${label}](${content.uri})` }];
  }

  const workspaceRoot = options.resolveSessionWorkspaceRoot(options.sessionId);
  if (!workspaceRoot) {
    throw new Error('Session workspace is not available on this machine');
  }

  const fileRoots = (await options.resolveSessionFileRoots?.(options.sessionId)) ?? [
    { id: 'main', absolutePath: workspaceRoot },
  ];
  const target = resolveProjectFileTarget(fileRoots, localPath);
  if (!target) throw new Error('Agent file is outside the session roots');
  const containedPath = target.absolutePath;
  const mimeType = normalizeACPMimeType(content.mimeType);

  if (shouldTreatACPPathAsImage(containedPath, mimeType)) {
    try {
      const image = await options.validateSessionImageUploadPath(containedPath);
      const uploaded = await options.uploadSessionImageFile({
        workspaceId: options.workspaceId,
        sessionId: options.sessionId,
        file: image,
      });
      return [toImageGroupContent(uploaded)];
    } catch (error) {
      options.logger.debug(
        `[${options.sessionId}] ACP resource_link image upload fallback to file: ${formatErrorMessage(error)}`
      );
    }
  }

  const file = await options.validateSessionFileUploadPath(containedPath, {
    fileRoots,
  });
  const uploaded = await options.uploadValidatedSessionFile({
    workspaceId: options.workspaceId,
    sessionId: options.sessionId,
    file,
  });
  return [toFileMessageContent({ ...uploaded, sourcePath: encodeSessionFilePath(target) })];
};

const materializeACPEmbeddedResourceContent = async (
  options: MaterializeACPAgentRichContentOptions,
  content: Extract<ContentBlock, { type: 'resource' }>
): Promise<MessageContent[]> => {
  const resource = content.resource;
  if ('text' in resource) {
    const mimeType = normalizeACPMimeType(resource.mimeType ?? 'text/plain');
    const bytes = Buffer.from(resource.text, 'utf8');
    const fileName = buildACPContentFileName({
      uri: resource.uri,
      fallbackStem: `agent-resource-${uuidV4()}`,
      mimeType,
    });
    const uploaded = await uploadACPBytesAsSessionFile(options, {
      fileName,
      mimeType,
      bytes,
    });
    return [toFileMessageContent(uploaded)];
  }

  const mimeType = normalizeACPMimeType(resource.mimeType);
  const bytes = decodeACPBase64Data(resource.blob, 'ACP resource');
  const fileName = buildACPContentFileName({
    uri: resource.uri,
    fallbackStem: `agent-resource-${uuidV4()}`,
    mimeType,
  });

  if (shouldUploadACPBytesAsImage(mimeType, bytes.byteLength)) {
    const uploaded = await uploadACPBytesAsSessionImage(options, {
      fileName,
      mimeType,
      bytes,
    });
    return [toImageGroupContent(uploaded)];
  }

  const uploaded = await uploadACPBytesAsSessionFile(options, {
    fileName,
    mimeType,
    bytes,
  });
  return [toFileMessageContent(uploaded)];
};

const materializeACPAudioContent = async (
  options: MaterializeACPAgentRichContentOptions,
  content: Extract<ContentBlock, { type: 'audio' }>
): Promise<MessageContent[]> => {
  const mimeType = normalizeACPMimeType(content.mimeType);
  const bytes = decodeACPBase64Data(content.data, 'ACP audio');
  const fileName = buildACPContentFileName({
    fallbackStem: `agent-audio-${uuidV4()}`,
    mimeType,
  });
  const uploaded = await uploadACPBytesAsSessionFile(options, {
    fileName,
    mimeType,
    bytes,
  });
  return [toFileMessageContent(uploaded)];
};

export const materializeACPAgentRichContent = async (
  options: MaterializeACPAgentRichContentOptions
): Promise<MessageContent[]> => {
  const update = options.notification.update;
  if (update.sessionUpdate !== 'agent_message_chunk' || update.content.type === 'text') {
    return [];
  }

  try {
    switch (update.content.type) {
      case 'image':
        return await materializeACPImageContent(options, update.content);
      case 'resource_link':
        return await materializeACPResourceLinkContent(options, update.content);
      case 'resource':
        return await materializeACPEmbeddedResourceContent(options, update.content);
      case 'audio':
        return await materializeACPAudioContent(options, update.content);
    }
    return [];
  } catch (error) {
    options.logger.warn(
      `[${options.sessionId}] Failed to materialize ACP ${update.content.type} content: ${formatErrorMessage(error)}`
    );
    return buildACPAttachmentUploadFailureContent(update.content.type);
  }
};
