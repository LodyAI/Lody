import { z } from 'zod';

/** Local control plane only. File bytes never travel in this response. */
export const LocalFileResolutionSchema = z
  .object({
    status: z.literal('local-file'),
    path: z.string().min(1),
    absolutePath: z.string().min(1),
    external: z.boolean(),
  })
  .strict();
export type LocalFileResolution = z.infer<typeof LocalFileResolutionSchema>;

/** Resource URLs are opaque, renderer-lifetime capabilities issued by Electron. */
export type LocalFilePreviewResource = {
  readonly status: 'resource';
  readonly path: string;
  readonly external: boolean;
  readonly kind: 'text' | 'binary';
  readonly sizeBytes: number;
  readonly url: string;
};

export const LOCAL_TEXT_PAGE_BYTES = 64 * 1024;
export const LOCAL_TEXT_EDIT_BYTES = 512 * 1024;
