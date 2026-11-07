export function decodeFrames(data: Uint8Array): Uint8Array[] {
  if (data[0] === 123) return [data];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength),
    items: Uint8Array[] = [];
  for (let offset = 0; offset < data.length;) {
    if (offset + 4 > data.length) throw new Error('Truncated update length');
    const length = view.getUint32(offset, false);
    offset += 4;
    if (offset + length > data.length) throw new Error('Truncated update body');
    if (length) items.push(data.subarray(offset, offset + length));
    offset += length;
  }
  return items;
}

export function encodeFrame(bytes: Uint8Array): Uint8Array {
  const framed = new Uint8Array(bytes.length + 4);
  new DataView(framed.buffer).setUint32(0, bytes.length, false);
  framed.set(bytes, 4);
  return framed;
}
