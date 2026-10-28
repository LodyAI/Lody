import type { SessionHistoryParsed, SessionId } from '@lody/shared';

type SessionImageLike =
  | Extract<SessionHistoryParsed['items'][number], { type: 'image' }>
  | Extract<
      Extract<SessionHistoryParsed['items'][number], { type: 'image_group' }>['images'][number],
      {
        imageId: string;
      }
    >;

export type SessionImageGalleryEntry = {
  encryption?: import('@lody/shared').EncryptedAttachment;
  key: string;
  sessionId: SessionId;
  messageId: string;
  galleryGroupId: string;
  imageId: string;
  mimeType: string;
  fileName?: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  alt?: string;
};

type CreateSessionImageGalleryEntryArgs = {
  sessionId: SessionId;
  messageId: string;
  galleryGroupId?: string;
  itemIndex: number;
  imageIndex: number;
  image: SessionImageLike;
};

export const createSessionImageGalleryEntry = ({
  sessionId,
  messageId,
  galleryGroupId = messageId,
  itemIndex,
  imageIndex,
  image,
}: CreateSessionImageGalleryEntryArgs): SessionImageGalleryEntry => ({
  key: `${messageId}:${itemIndex}:${imageIndex}:${image.imageId}`,
  sessionId: image.storageSessionId ?? sessionId,
  messageId,
  galleryGroupId,
  imageId: image.imageId,
  encryption: image.encryption,
  mimeType: image.mimeType,
  fileName: image.fileName,
  sizeBytes: image.sizeBytes,
  width: image.width,
  height: image.height,
  alt: image.fileName,
});

const resolveGalleryGroupId = (message: SessionHistoryParsed): string => {
  if (message.role === 'user') {
    return message.id;
  }

  const userTurnId = message.userTurnId?.trim();
  return userTurnId || message.id;
};

export const collectSessionImageGalleryEntries = (
  messages: ReadonlyArray<SessionHistoryParsed>,
  sessionId: SessionId
): SessionImageGalleryEntry[] => {
  const entries: SessionImageGalleryEntry[] = [];

  for (const message of messages) {
    const galleryGroupId = resolveGalleryGroupId(message);

    message.items.forEach((item, itemIndex) => {
      if (item.type === 'image') {
        entries.push(
          createSessionImageGalleryEntry({
            sessionId,
            messageId: message.id,
            galleryGroupId,
            itemIndex,
            imageIndex: 0,
            image: item,
          })
        );
        return;
      }

      if (item.type !== 'image_group') {
        return;
      }

      item.images.forEach((image, imageIndex) => {
        entries.push(
          createSessionImageGalleryEntry({
            sessionId,
            messageId: message.id,
            galleryGroupId,
            itemIndex,
            imageIndex,
            image,
          })
        );
      });
    });
  }

  return entries;
};

export const findSessionImageGalleryEntryIndex = (
  entries: ReadonlyArray<SessionImageGalleryEntry>,
  key: string | null
): number => {
  if (!key) {
    return -1;
  }
  return entries.findIndex((entry) => entry.key === key);
};
