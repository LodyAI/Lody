// Synthetic baseline SPS/PPS and slice headers; no captured screen pixels.
function rbsp(bits: string) {
  const padded = (bits + '1').padEnd(Math.ceil((bits.length + 1) / 8) * 8, '0');
  return Buffer.from(padded.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? []);
}
const ue = (n: number) => {
  const b = (n + 1).toString(2);
  return '0'.repeat(b.length - 1) + b;
};
const sps = Buffer.concat([
  Buffer.from([0x67, 66, 0, 30]),
  rbsp(ue(0) + ue(0) + ue(2) + ue(1) + '0' + ue(39) + ue(79) + '1'),
]);
const pps = Buffer.concat([Buffer.from([0x68]), rbsp(ue(0) + ue(0))]);
export const description = Buffer.concat([
  Buffer.from([1, 66, 0, 30, 255, 225, 0, sps.length]),
  sps,
  Buffer.from([1, 0, pps.length]),
  pps,
]);
export function frame(n: number, key = n === 0, size = 100) {
  const nal = Buffer.concat([
    Buffer.from([key ? 0x65 : 0x41]),
    rbsp(ue(0) + ue(key ? 2 : 0) + ue(0) + n.toString(2).padStart(4, '0')),
    Buffer.alloc(size),
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(nal.length);
  return Buffer.concat([Buffer.from([key ? 2 : 3]), length, nal]);
}
