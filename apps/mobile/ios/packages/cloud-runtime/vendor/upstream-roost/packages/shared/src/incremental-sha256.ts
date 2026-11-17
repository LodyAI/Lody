// Incremental FIPS 180-4 SHA-256 for runtimes where WebCrypto's one-shot
// digest would require buffering the entire input first.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value: number, bits: number): number => {
  return (value >>> bits) | (value << (32 - bits));
};

export class IncrementalSha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  private readonly block = new Uint8Array(64);
  private blockLength = 0;
  private totalLength = 0;
  private readonly w = new Uint32Array(64);

  update(chunk: Uint8Array): void {
    this.totalLength += chunk.length;
    let offset = 0;

    if (this.blockLength > 0) {
      const needed = 64 - this.blockLength;
      const take = Math.min(needed, chunk.length);
      this.block.set(chunk.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset = take;
      if (this.blockLength === 64) {
        this.processBlock(this.block, 0);
        this.blockLength = 0;
      }
    }

    while (offset + 64 <= chunk.length) {
      this.processBlock(chunk, offset);
      offset += 64;
    }

    if (offset < chunk.length) {
      const rest = chunk.subarray(offset);
      this.block.set(rest, this.blockLength);
      this.blockLength += rest.length;
    }
  }

  /** Finalize and return the lowercase hex digest. Do not call `update` after. */
  digestHex(): string {
    const bitLength = this.totalLength * 8;
    const pad = new Uint8Array(
      this.blockLength < 56 ? 64 - this.blockLength : 128 - this.blockLength
    );
    pad[0] = 0x80;

    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    const dv = new DataView(pad.buffer, pad.byteOffset, pad.byteLength);
    dv.setUint32(pad.length - 8, high);
    dv.setUint32(pad.length - 4, low);
    this.update(pad);

    let hex = '';
    for (let i = 0; i < 8; i += 1) {
      hex += this.h[i]!.toString(16).padStart(8, '0');
    }
    return hex;
  }

  private processBlock(data: Uint8Array, start: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i += 1) {
      const j = start + i * 4;
      w[i] = (data[j]! << 24) | (data[j + 1]! << 16) | (data[j + 2]! << 8) | data[j + 3]!;
    }
    for (let i = 16; i < 64; i += 1) {
      const word15 = w[i - 15]!;
      const word2 = w[i - 2]!;
      const s0 = rotr(word15, 7) ^ rotr(word15, 18) ^ (word15 >>> 3);
      const s1 = rotr(word2, 17) ^ rotr(word2, 19) ^ (word2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }

    let a = this.h[0]!;
    let b = this.h[1]!;
    let c = this.h[2]!;
    let d = this.h[3]!;
    let e = this.h[4]!;
    let f = this.h[5]!;
    let g = this.h[6]!;
    let hh = this.h[7]!;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + K[i]! + w[i]!) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    this.h[0] = (this.h[0]! + a) | 0;
    this.h[1] = (this.h[1]! + b) | 0;
    this.h[2] = (this.h[2]! + c) | 0;
    this.h[3] = (this.h[3]! + d) | 0;
    this.h[4] = (this.h[4]! + e) | 0;
    this.h[5] = (this.h[5]! + f) | 0;
    this.h[6] = (this.h[6]! + g) | 0;
    this.h[7] = (this.h[7]! + hh) | 0;
  }
}

export const sha256Hex = (bytes: Uint8Array): string => {
  const hasher = new IncrementalSha256();
  hasher.update(bytes);
  return hasher.digestHex();
};
