import { z } from 'zod';
import { SessionFileRootIdSchema } from './project-path';
import { FilePreviewV3ErrorCodeSchema } from './file-preview';

export const FILE_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const FILE_DOWNLOAD_CHUNK_BYTES = 512 * 1024;
export const FileDownloadRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    rootId: SessionFileRootIdSchema.optional(),
    path: z.string().min(1),
    offset: z.number().int().min(0).max(FILE_DOWNLOAD_MAX_BYTES),
    revision: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
  })
  .strict()
  .refine((request) => request.offset === 0 || request.revision !== undefined);
export type FileDownloadRequest = z.infer<typeof FileDownloadRequestSchema>;
export const FileDownloadResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      path: z.string().min(1),
      revision: z.string().regex(/^[0-9a-f]{64}$/u),
      sizeBytes: z.number().int().min(0).max(FILE_DOWNLOAD_MAX_BYTES),
      offset: z.number().int().min(0).max(FILE_DOWNLOAD_MAX_BYTES),
      data: z.string().max(4 * Math.ceil(FILE_DOWNLOAD_CHUNK_BYTES / 3)),
    })
    .strict(),
  z
    .object({
      status: z.literal('error'),
      code: z.union([FilePreviewV3ErrorCodeSchema, z.enum(['paid_plan_required', 'file_changed'])]),
    })
    .strict(),
]);
export type FileDownloadResponse = z.infer<typeof FileDownloadResponseSchema>;
