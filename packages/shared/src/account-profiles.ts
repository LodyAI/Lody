import { z } from 'zod';

export const SYSTEM_DEFAULT_ACCOUNT_PROFILE_ID = 'system-default';

export const AccountProfileIdSchema = z.union([
  z.literal(SYSTEM_DEFAULT_ACCOUNT_PROFILE_ID),
  z.uuid(),
]);

export const AccountProfileSummarySchema = z
  .object({
    accountProfileId: AccountProfileIdSchema,
    label: z.string().trim().min(1).max(120),
    identity: z.string().max(320).optional(),
    status: z.enum(['authenticated', 'unauthenticated', 'unknown', 'error']),
  })
  .strict();

export type AccountProfileSummary = z.infer<typeof AccountProfileSummarySchema>;

export function resolveAccountProfileId(accountProfileId?: string): string {
  return accountProfileId ?? SYSTEM_DEFAULT_ACCOUNT_PROFILE_ID;
}
