import { avcFrameInfo, parseAvcDescription, type AvcDescription } from './h264-codec';
import type { H264Packet } from '../device-preview/h264-flow';
/** VideoToolbox reference validation belongs to the pinned iOS encoder only. */
export function createBaguetteH264Parser() {
  let description: AvcDescription | undefined;
  let reference: number | undefined;
  return (message: Buffer): H264Packet[] => {
    const tag = message[0],
      payload = message.subarray(1);
    if (tag === 4) return [];
    if (tag === 1) {
      description = parseAvcDescription(payload);
      reference = undefined;
      return [{ type: 'configuration', data: description.bytes }];
    }
    if ((tag !== 2 && tag !== 3) || !description || payload.length > 2 * 1024 * 1024)
      throw Error('AVC packet');
    const info = avcFrameInfo(payload, description);
    if (info.key !== (tag === 2)) throw Error('AVC key tag');
    const gap =
      !info.key &&
      (reference === undefined || info.frameNum !== (reference + 1) % 2 ** description.frameBits);
    if (info.reference) reference = info.frameNum;
    return [
      ...(gap ? [{ type: 'discontinuity' as const }] : []),
      { type: 'frame', key: info.key, data: payload },
    ];
  };
}
