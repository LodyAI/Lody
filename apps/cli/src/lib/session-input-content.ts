import {
  SessionInputBlockSchema,
  SESSION_FILE_MAX_COUNT,
  type SessionInputBlock,
} from '@lody/shared';
import { z } from 'zod';

export type SessionInputAttachment = Extract<SessionInputBlock, { type: 'image' | 'file' }>;
export const SessionInputAttachmentsSchema = z
  .array(
    SessionInputBlockSchema.refine(
      (block) => block.type === 'image' || block.type === 'file',
      'Expected an image or file attachment'
    )
  )
  .max(SESSION_FILE_MAX_COUNT);

/** Validate durable references at recovery boundaries, never trust a JSON cast. */
export function parseSessionInputAttachments(value: unknown): SessionInputAttachment[] {
  return SessionInputAttachmentsSchema.parse(value) as SessionInputAttachment[];
}

export function buildCommandInputBlocks(
  prompt: string,
  attachments: readonly SessionInputAttachment[] = []
): SessionInputBlock[] {
  const blocks: SessionInputBlock[] = [
    ...(prompt.trim() ? [{ type: 'text' as const, text: prompt }] : []),
    ...parseSessionInputAttachments(attachments),
  ];
  if (!blocks.length) throw new Error('A message needs text or at least one attachment');
  return blocks;
}
