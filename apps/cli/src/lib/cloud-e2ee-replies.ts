import { z } from 'zod';
import type { E2eeMailboxReplies, E2eeWorkspaceHistoryPage } from '@lody/cloud-api';

// Foreign-boundary schemas for the CLI E2EE cloud port. They mirror the Electron
// cloud client's checks: malformed replies fail here, never inside ledger ingest.
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const nonnegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bytesHex = (max: number) =>
  z
    .string()
    .regex(/^(?:[0-9a-f]{2})+$/)
    .max(max * 2);
const slot = z.object({ genesis: hash, epoch: nonnegative, recipient: hash });

export const e2eeHistoryPageSchema: z.ZodType<E2eeWorkspaceHistoryPage> = z.object({
  workspaceId: z.string().min(1),
  genesisHash: hash,
  checkpoint: z.object({ headHash: hash, length: nonnegative }),
  startIndex: nonnegative,
  recordsHex: z.array(bytesHex(16_384)).max(64),
  position: z.string().min(1),
  nextCursor: z.string().min(1).nullable(),
});

export const e2eeMailboxReplySchemas: {
  [K in keyof E2eeMailboxReplies]: z.ZodType<E2eeMailboxReplies[K]>;
} = {
  put: z.null(),
  report: z.null(),
  repair: z.null(),
  read: bytesHex(512).nullable(),
  fetch: z.object({
    items: z.array(z.object({ sender: hash, frameHex: bytesHex(512) })).max(100),
    next: z
      .string()
      .regex(/^[0-9a-f]{64}:[0-9a-f]{64}$/)
      .nullable(),
  }),
  status: slot.extend({
    revision: nonnegative,
    status: z.enum([
      'NeedsEnvelope',
      'EnvelopeStored',
      'InstallationReported',
      'Ineligible',
      'Obsolete',
    ]),
  }),
};
