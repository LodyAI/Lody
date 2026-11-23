/** Convert bounded Annex-B NAL units at the platform boundary, never in the viewer. */
function nals(bytes: Buffer): Buffer[] {
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw Error('Invalid H264 packet');
  const starts: Array<{ at: number; size: number }> = [];
  for (let i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
    const size = bytes[i + 2] === 1 ? 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0;
    if (size) {
      starts.push({ at: i, size });
      i += size - 1;
    }
  }
  if (!starts.length || starts[0]?.at !== 0 || starts.length > 4096) throw Error('Invalid Annex B');
  return starts.map((s, i) => {
    const nal = bytes.subarray(s.at + s.size, starts[i + 1]?.at ?? bytes.length);
    if (!nal.length) throw Error('Empty NAL');
    return nal;
  });
}
export function annexBToAvcc(bytes: Buffer): Buffer {
  return Buffer.concat(
    nals(bytes).flatMap((nal) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(nal.length);
      return [length, nal];
    })
  );
}
export function avcConfiguration(bytes: Buffer): Buffer {
  const units = nals(bytes);
  const sps = units.find((n) => (n[0] ?? 0) % 32 === 7);
  const pps = units.find((n) => (n[0] ?? 0) % 32 === 8);
  if (!sps || !pps || sps.length < 4 || sps.length + pps.length > 4000)
    throw Error('Invalid AVC configuration');
  const prefix = Buffer.from([1, sps[1] ?? 0, sps[2] ?? 0, sps[3] ?? 0, 255, 225, 0, 0]);
  prefix.writeUInt16BE(sps.length, 6);
  const suffix = Buffer.from([1, 0, 0]);
  suffix.writeUInt16BE(pps.length, 1);
  return Buffer.concat([prefix, sps, suffix, pps]);
}
