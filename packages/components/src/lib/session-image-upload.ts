import {
  buildSessionImageApiUrl,
  getSessionImageDownloadApiPath,
  getSessionImageThumbnailApiPath,
  getSessionImageUploadApiPath,
  SESSION_IMAGE_ALLOWED_EXTENSIONS,
  SESSION_IMAGE_ALLOWED_MIME_TYPES,
  SESSION_IMAGE_MAX_SIZE_BYTES,
  SessionInputBlockSchema,
  type SessionImageThumbnailOptions,
  type SessionId,
  type SessionImagePayload,
  type WorkspaceId,
} from '@lody/shared';
import { API_BASE_URL } from '@/lib';
import { postMultipartWithProgress } from '@/lib/multipart-upload';

const allowedExtensionSet = new Set<string>(SESSION_IMAGE_ALLOWED_EXTENSIONS);
const allowedMimeTypeSet = new Set<string>(SESSION_IMAGE_ALLOWED_MIME_TYPES);

export const SESSION_IMAGE_ACCEPT = [
  ...SESSION_IMAGE_ALLOWED_MIME_TYPES,
  ...SESSION_IMAGE_ALLOWED_EXTENSIONS.map((extension) => `.${extension}`),
].join(',');

export const getFileExtension = (fileName: string): string => {
  const trimmed = fileName.trim().toLowerCase();
  const dotIndex = trimmed.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === trimmed.length - 1) {
    return '';
  }
  return trimmed.slice(dotIndex + 1);
};

export const validateSessionImageFile = (file: File): string | null => {
  const extension = getFileExtension(file.name);
  if (extension && !allowedExtensionSet.has(extension)) {
    return `Unsupported file extension: ${file.name}`;
  }

  const mimeType = file.type.trim().toLowerCase();
  if (!allowedMimeTypeSet.has(mimeType)) {
    return `Unsupported image type: ${mimeType || 'unknown'}`;
  }

  if (file.size > SESSION_IMAGE_MAX_SIZE_BYTES) {
    return `Image must be <= ${Math.floor(SESSION_IMAGE_MAX_SIZE_BYTES / (1024 * 1024))}MB`;
  }

  if (file.size <= 0) {
    return 'Image is empty';
  }

  return null;
};

export const buildSessionImageUploadUrl = (workspaceId: WorkspaceId): string => {
  return buildSessionImageApiUrl(API_BASE_URL, getSessionImageUploadApiPath(workspaceId));
};

export const buildSessionImageDownloadUrl = (
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  imageId: string
): string => {
  return buildSessionImageApiUrl(
    API_BASE_URL,
    getSessionImageDownloadApiPath(workspaceId, sessionId, imageId)
  );
};

export const buildSessionImageThumbnailUrl = (
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  imageId: string,
  options: SessionImageThumbnailOptions
): string => {
  return buildSessionImageApiUrl(
    API_BASE_URL,
    getSessionImageThumbnailApiPath(workspaceId, sessionId, imageId, options)
  );
};

type UploadSessionImageArgs = {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  token: string;
  file: File;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
};

export const uploadSessionImage = async ({
  workspaceId,
  sessionId,
  token,
  file,
  onProgress,
  signal,
}: UploadSessionImageArgs): Promise<SessionImagePayload> => {
  const validationError = validateSessionImageFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  const formData = new FormData();
  formData.set('sessionId', sessionId);
  formData.set('file', file, file.name);

  const responseBody = await postMultipartWithProgress({
    url: buildSessionImageUploadUrl(workspaceId),
    token,
    formData,
    onProgress,
    errorLabel: 'Image upload',
    signal,
  });

  const imageValue =
    responseBody && typeof responseBody === 'object' && 'image' in responseBody
      ? (responseBody as { image?: unknown }).image
      : undefined;

  const parsed = SessionInputBlockSchema.safeParse(imageValue);
  if (!parsed.success || parsed.data.type !== 'image') {
    throw new Error('Invalid upload payload');
  }

  return {
    imageId: parsed.data.imageId,
    mimeType: parsed.data.mimeType,
    fileName: parsed.data.fileName,
    sizeBytes: parsed.data.sizeBytes,
    width: parsed.data.width,
    height: parsed.data.height,
  };
};
