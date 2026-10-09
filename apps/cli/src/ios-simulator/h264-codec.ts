/** Minimal, bounded parser for the pinned VideoToolbox encoder's progressive AVC.
 * Reject unsupported layouts rather than guessing reference continuity. This catches
 * loss inside Baguette's own latest-frame backlog before a corrupt chain reaches WebCodecs.
 */
class Bits {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  read(count: number): number {
    if (count > 32 || this.offset + count > this.bytes.length * 8) throw Error('AVC bits');
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.bytes[this.offset >> 3] ?? 0;
      value = value * 2 + ((byte >> (7 - (this.offset++ & 7))) & 1);
    }
    return value;
  }
  ue(): number {
    let zeros = 0;
    while (this.read(1) === 0) if (++zeros > 24) throw Error('AVC exp-golomb');
    return 2 ** zeros - 1 + this.read(zeros);
  }
  se(): number {
    const n = this.ue();
    return n & 1 ? (n + 1) / 2 : -n / 2;
  }
}
function bits(nal: Buffer) {
  const rbsp: number[] = [];
  for (let i = 1; i < nal.length; i++) {
    if (nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    rbsp.push(nal[i] ?? 0);
  }
  return new Bits(Uint8Array.from(rbsp));
}
export type AvcDescription = { bytes: Buffer; frameBits: number; ppsId: number };
export function parseAvcDescription(bytes: Buffer): AvcDescription {
  if (
    bytes.length < 12 ||
    bytes.length > 4096 ||
    bytes[0] !== 1 ||
    bytes[4] !== 255 ||
    bytes[5] !== 225
  )
    throw Error('AVC description');
  const spsLength = bytes.readUInt16BE(6),
    end = 8 + spsLength;
  if (spsLength < 5 || end + 3 > bytes.length || (bytes[8] ?? 0) % 32 !== 7 || bytes[end] !== 1)
    throw Error('AVC SPS');
  const ppsLength = bytes.readUInt16BE(end + 1);
  if (end + 3 + ppsLength > bytes.length || (bytes[end + 3] ?? 0) % 32 !== 8)
    throw Error('AVC PPS');
  const s = bits(bytes.subarray(8, end));
  const profile = s.read(8);
  s.read(16);
  const spsId = s.ue();
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    if (s.ue() !== 1 || s.ue() !== 0 || s.ue() !== 0) throw Error('AVC chroma');
    s.read(1);
    if (s.read(1)) {
      for (let i = 0; i < 8; i++)
        if (s.read(1)) {
          let last = 8,
            next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next !== 0) next = (last + s.se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
    }
  } else if (![66, 77, 88].includes(profile)) throw Error('AVC profile');
  const frameBits = s.ue() + 4;
  if (frameBits > 16) throw Error('AVC frame number');
  const poc = s.ue();
  if (poc === 0) s.ue();
  else if (poc === 1) {
    s.read(1);
    s.se();
    s.se();
    const n = s.ue();
    if (n > 255) throw Error('AVC cycle');
    for (let i = 0; i < n; i++) s.se();
  } else if (poc !== 2) throw Error('AVC POC');
  s.ue();
  s.read(1);
  s.ue();
  s.ue();
  if (s.read(1) !== 1) throw Error('AVC interlaced');
  const p = bits(bytes.subarray(end + 3, end + 3 + ppsLength));
  const ppsId = p.ue();
  if (p.ue() !== spsId) throw Error('AVC parameter set');
  return { bytes, frameBits, ppsId };
}
export function avcFrameInfo(payload: Buffer, description: AvcDescription) {
  let offset = 0,
    result: { frameNum: number; key: boolean; reference: boolean } | undefined;
  while (offset < payload.length) {
    if (offset + 4 > payload.length) throw Error('AVC NAL');
    const size = payload.readUInt32BE(offset);
    offset += 4;
    if (size < 1 || size > payload.length - offset) throw Error('AVC NAL length');
    const nal = payload.subarray(offset, offset + size);
    offset += size;
    const header = nal[0] ?? 0,
      type = header & 31;
    if (header & 128) throw Error('AVC forbidden bit');
    if (type !== 1 && type !== 5) {
      if (![6, 9, 12].includes(type)) throw Error('AVC unexpected NAL');
      continue;
    }
    // Slice headers are short; never duplicate an entire large keyframe to read them.
    const b = bits(nal.subarray(0, 128));
    b.ue();
    const sliceType = b.ue() % 5;
    if (sliceType !== 0 && sliceType !== 2) throw Error('AVC reordered slice');
    if (b.ue() !== description.ppsId) throw Error('AVC PPS changed');
    const frameNum = b.read(description.frameBits),
      key = type === 5,
      reference = (header & 96) !== 0;
    if (
      result &&
      (frameNum !== result.frameNum || key !== result.key || reference !== result.reference)
    )
      throw Error('AVC mixed picture');
    result = { frameNum, key, reference };
  }
  if (!result || (result.key && result.frameNum !== 0)) throw Error('AVC picture');
  return result;
}
