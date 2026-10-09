import { z } from 'zod';

// ICE configuration comes only from the host's cloud port, never from an offer.
export const SimulatorIceServersSchema = z
  .array(
    z
      .object({
        urls: z
          .array(
            z
              .string()
              .max(512)
              .regex(/^(stun|turn|turns):/)
          )
          .min(1)
          .max(8),
        username: z.string().max(1024).optional(),
        credential: z.string().max(4096).optional(),
      })
      .strict()
  )
  .max(8);
export type SimulatorIceServer = z.infer<typeof SimulatorIceServersSchema>[number];
export const SimulatorOfferSchema = z
  .object({
    sdp: z
      .string()
      .min(1)
      .max(64 * 1024),
    codec: z.enum(['h264', 'mjpeg']),
  })
  .strict();

// SCTP messages stay below browser interoperability limits. A reliable ordered
// channel preserves the existing H.264 reference chain. At most one frame is
// reassembled; the frame header carries its total length, never a trusted allocation.
export const RTC_CHUNK_BYTES = 16 * 1024;
export const RTC_MAX_FRAME_BYTES = 16 * 1024 * 1024 + 8;
export function* simulatorRtcChunks(frame: Buffer): Generator<Buffer> {
  if (frame.length < 1 || frame.length > RTC_MAX_FRAME_BYTES) throw Error('Invalid RTC frame');
  for (let offset = 0; offset < frame.length; offset += RTC_CHUNK_BYTES - 8) {
    const payload = frame.subarray(offset, offset + RTC_CHUNK_BYTES - 8);
    const chunk = Buffer.allocUnsafe(payload.length + 8);
    chunk.writeUInt32BE(frame.length, 0);
    chunk.writeUInt32BE(offset, 4);
    payload.copy(chunk, 8);
    yield chunk;
  }
}
