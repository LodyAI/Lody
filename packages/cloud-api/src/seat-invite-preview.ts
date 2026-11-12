import { z } from 'zod';

/** Cloud seat quote and payment-recovery hints. These fields inform the UI; only
 * the backend's admission transaction authorizes membership and charges. Unknown
 * transport metadata is stripped, while known optional fields remain validated. */
export const SeatInvitePreviewSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('not_billed'),
    reason: z.enum(['free', 'covered']),
    availableSeats: z.number().optional(),
  }),
  z.object({
    status: z.literal('billed'),
    interval: z.enum(['month', 'year']),
    unitAmount: z.number().nullable(),
    proratedAmount: z.number().nullable(),
    currentPeriodEnd: z.number().nullable(),
    seatCount: z.number(),
    nextSeatCount: z.number(),
    nextRenewalAmount: z.number().nullable(),
    currency: z.string().optional(),
    addedSeats: z.number().optional(),
    paymentAction: z.enum(['method_required', 'payment_required', 'refresh']).optional(),
    invoiceAt: z.number().nullable().optional(),
  }),
]);

/** Cost of the next admission and the action needed before it can proceed. */
export type SeatInvitePreview = z.infer<typeof SeatInvitePreviewSchema>;
