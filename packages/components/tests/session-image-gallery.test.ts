import { describe, expect, it } from 'vitest';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import { collectSessionImageGalleryEntries } from '../src/lib/session-image-gallery';

const sessionId = 'session-1' as SessionId;

const buildMessage = (
  overrides: Partial<SessionHistoryParsed> & Pick<SessionHistoryParsed, 'id' | 'items'>
): SessionHistoryParsed => ({
  id: overrides.id,
  role: overrides.role ?? 'user',
  timestamp: overrides.timestamp ?? '2026-04-03T00:00:00.000Z',
  read: overrides.read ?? true,
  userId: overrides.userId,
  userTurnId: overrides.userTurnId,
  items: overrides.items,
  fileDiff: overrides.fileDiff,
  finished: overrides.finished,
  modelInfo: overrides.modelInfo,
  plan: overrides.plan,
  endedAt: overrides.endedAt,
});

describe('collectSessionImageGalleryEntries', () => {
  it('preserves conversation order across image items and image groups', () => {
    const messages: SessionHistoryParsed[] = [
      buildMessage({
        id: 'm-1',
        items: [
          {
            type: 'text',
            text: 'before',
          },
          {
            type: 'image',
            imageId: 'img-1',
            mimeType: 'image/png',
            fileName: 'first.png',
            sizeBytes: 128,
          },
        ],
      }),
      buildMessage({
        id: 'm-2',
        role: 'assistant',
        items: [
          {
            type: 'image_group',
            images: [
              {
                imageId: 'img-2',
                mimeType: 'image/jpeg',
                fileName: 'second.jpg',
                sizeBytes: 256,
              },
              {
                imageId: 'img-3',
                mimeType: 'image/webp',
                sizeBytes: 512,
              },
            ],
          },
        ],
      }),
    ];

    expect(collectSessionImageGalleryEntries(messages, sessionId)).toEqual([
      {
        key: 'm-1:1:0:img-1',
        sessionId,
        messageId: 'm-1',
        galleryGroupId: 'm-1',
        imageId: 'img-1',
        mimeType: 'image/png',
        fileName: 'first.png',
        sizeBytes: 128,
        width: undefined,
        height: undefined,
        alt: 'first.png',
      },
      {
        key: 'm-2:0:0:img-2',
        sessionId,
        messageId: 'm-2',
        galleryGroupId: 'm-2',
        imageId: 'img-2',
        mimeType: 'image/jpeg',
        fileName: 'second.jpg',
        sizeBytes: 256,
        width: undefined,
        height: undefined,
        alt: 'second.jpg',
      },
      {
        key: 'm-2:0:1:img-3',
        sessionId,
        messageId: 'm-2',
        galleryGroupId: 'm-2',
        imageId: 'img-3',
        mimeType: 'image/webp',
        fileName: undefined,
        sizeBytes: 512,
        width: undefined,
        height: undefined,
        alt: undefined,
      },
    ]);
  });

  it('groups assistant images under their originating user turn', () => {
    const messages: SessionHistoryParsed[] = [
      buildMessage({
        id: 'user-1',
        role: 'user',
        items: [
          {
            type: 'image',
            imageId: 'img-user',
            mimeType: 'image/png',
            sizeBytes: 128,
          },
        ],
      }),
      buildMessage({
        id: 'assistant-1',
        role: 'assistant',
        userTurnId: 'user-1',
        items: [
          {
            type: 'image_group',
            images: [
              {
                imageId: 'img-assistant-1',
                mimeType: 'image/jpeg',
                sizeBytes: 256,
              },
              {
                imageId: 'img-assistant-2',
                mimeType: 'image/webp',
                sizeBytes: 512,
              },
            ],
          },
        ],
      }),
    ];

    expect(collectSessionImageGalleryEntries(messages, sessionId)).toEqual([
      expect.objectContaining({
        key: 'user-1:0:0:img-user',
        galleryGroupId: 'user-1',
      }),
      expect.objectContaining({
        key: 'assistant-1:0:0:img-assistant-1',
        galleryGroupId: 'user-1',
      }),
      expect.objectContaining({
        key: 'assistant-1:0:1:img-assistant-2',
        galleryGroupId: 'user-1',
      }),
    ]);
  });

  it('falls back to the message id when assistant turn linkage is missing', () => {
    const messages: SessionHistoryParsed[] = [
      buildMessage({
        id: 'assistant-legacy',
        role: 'assistant',
        items: [
          {
            type: 'image',
            imageId: 'img-legacy',
            mimeType: 'image/png',
            sizeBytes: 64,
          },
        ],
      }),
    ];

    expect(collectSessionImageGalleryEntries(messages, sessionId)).toEqual([
      expect.objectContaining({
        key: 'assistant-legacy:0:0:img-legacy',
        galleryGroupId: 'assistant-legacy',
      }),
    ]);
  });
});
