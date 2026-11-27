// QR File Drop wire protocol: a systematic random linear fountain code.
//
// The sender splits a "container" (metadata + file bytes) into K blocks of
// blockSize bytes. Frame index i < K carries source block i as-is; every frame
// i >= K carries the XOR of a pseudo-random half of the blocks, chosen by a PRNG
// seeded by (transferId, i). (This is an LT-family code with a dense binomial
// degree distribution, decoded with online Gaussian elimination.) Any large enough set of
// distinct frames, in any order, rebuilds the container. There is no back
// channel.
//
// Frame layout (big endian, 17-byte header then payload):
//   0  'Q' 'F'          magic
//   2  u8   version     (1)
//   3  u16  blockSize
//   5  u32  transferId  (random per file; a new id resets the receiver)
//   9  u32  totalLength (container length in bytes)
//   13 u32  index       (frame index, also the LT seed)
//   17 ...  payload     (blockSize bytes)
//
// Container layout:
//   32 bytes SHA-256 of the file | u32 fileSize | u16 nameLen | name (UTF-8)
//   | u8 mimeLen | mime (UTF-8) | file bytes

export const MAGIC0 = 0x51; // 'Q'
export const MAGIC1 = 0x46; // 'F'
export const VERSION = 1;
export const HEADER_SIZE = 17;

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function sha256(bytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error("This browser cannot check files (no crypto.subtle). Open the page over https.");
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}

export async function buildContainer(fileBytes, name, mime) {
  const hash = await sha256(fileBytes);
  let nameB = enc.encode(name || "file");
  if (nameB.length > 255 * 4) nameB = nameB.slice(0, 1000);
  let mimeB = enc.encode(mime || "application/octet-stream");
  if (mimeB.length > 255) mimeB = enc.encode("application/octet-stream");
  const out = new Uint8Array(32 + 4 + 2 + nameB.length + 1 + mimeB.length + fileBytes.length);
  const dv = new DataView(out.buffer);
  let o = 0;
  out.set(hash, o); o += 32;
  dv.setUint32(o, fileBytes.length); o += 4;
  dv.setUint16(o, nameB.length); o += 2;
  out.set(nameB, o); o += nameB.length;
  out[o++] = mimeB.length;
  out.set(mimeB, o); o += mimeB.length;
  out.set(fileBytes, o);
  return out;
}

// Parses a rebuilt container and checks the SHA-256. Throws on any mismatch.
export async function openContainer(container) {
  const dv = new DataView(container.buffer, container.byteOffset, container.byteLength);
  let o = 0;
  const hash = container.slice(0, 32); o += 32;
  const fileSize = dv.getUint32(o); o += 4;
  const nameLen = dv.getUint16(o); o += 2;
  const name = dec.decode(container.subarray(o, o + nameLen)); o += nameLen;
  const mimeLen = container[o++];
  const mime = dec.decode(container.subarray(o, o + mimeLen)); o += mimeLen;
  if (o + fileSize !== container.length) throw new Error("size mismatch");
  const file = container.slice(o);
  const got = await sha256(file);
  for (let i = 0; i < 32; i++) if (got[i] !== hash[i]) throw new Error("checksum mismatch");
  return { name, mime, file, hash };
}

// --- PRNG + degree distribution ---------------------------------------------

function mix32(a, b) {
  // splitmix-style hash of two u32 into one u32 seed
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0 || 1;
}

// Which source blocks frame `index` combines, as a K-bit row (Uint32 words).
// Frames 0..K-1 are systematic (one block each). Every later frame picks each
// block with probability 1/2 (a dense random linear fountain code over GF(2)).
// Dense rows cost a little more CPU than sparse LT rows, but any K+2 or so
// distinct frames rebuild the file, while sparse LT needs ~15-35% extra.
export function rowForIndex(transferId, index, K) {
  const W = (K + 31) >>> 5;
  const row = new Uint32Array(W);
  if (index < K) { row[index >>> 5] = 1 << (index & 31); return row; }
  const r = rng32(mix32(transferId, index));
  for (let w = 0; w < W; w++) row[w] = r();
  if (K & 31) row[W - 1] &= (1 << (K & 31)) - 1 >>> 0;
  let any = 0;
  for (let w = 0; w < W; w++) any |= row[w];
  if (!any) { const c = index % K; row[c >>> 5] |= 1 << (c & 31); }
  return row;
}

function rng32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export function blocksForIndex(transferId, index, K) {
  const row = rowForIndex(transferId, index, K);
  const out = [];
  for (let k = 0; k < K; k++) if (row[k >>> 5] & (1 << (k & 31))) out.push(k);
  return out;
}

function xorInto(dst, src) {
  const n = dst.length;
  if ((n & 3) === 0 && (dst.byteOffset & 3) === 0 && (src.byteOffset & 3) === 0) {
    const a = new Uint32Array(dst.buffer, dst.byteOffset, n >> 2);
    const b = new Uint32Array(src.buffer, src.byteOffset, n >> 2);
    for (let i = 0; i < a.length; i++) a[i] ^= b[i];
    return;
  }
  for (let i = 0; i < n; i++) dst[i] ^= src[i];
}

// --- Encoder -----------------------------------------------------------------

export class Encoder {
  constructor(container, blockSize, transferId) {
    if (blockSize < 16 || blockSize > 2900 || blockSize % 4) throw new Error("bad block size");
    this.blockSize = blockSize;
    this.transferId = transferId >>> 0;
    this.totalLength = container.length;
    this.K = Math.max(1, Math.ceil(container.length / blockSize));
    this.blocks = [];
    for (let k = 0; k < this.K; k++) {
      const b = new Uint8Array(blockSize);
      b.set(container.subarray(k * blockSize, (k + 1) * blockSize));
      this.blocks.push(b);
    }
  }
  frame(index) {
    const out = new Uint8Array(HEADER_SIZE + this.blockSize);
    const dv = new DataView(out.buffer);
    out[0] = MAGIC0; out[1] = MAGIC1; out[2] = VERSION;
    dv.setUint16(3, this.blockSize);
    dv.setUint32(5, this.transferId);
    dv.setUint32(9, this.totalLength);
    dv.setUint32(13, index >>> 0);
    const payload = out.subarray(HEADER_SIZE);
    for (const k of blocksForIndex(this.transferId, index >>> 0, this.K)) xorInto(payload, this.blocks[k]);
    return out;
  }
}

export function parseFrame(bytes) {
  if (!bytes || bytes.length < HEADER_SIZE + 1) return null;
  if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1 || bytes[2] !== VERSION) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blockSize = dv.getUint16(3);
  if (bytes.length !== HEADER_SIZE + blockSize) return null;
  return {
    blockSize,
    transferId: dv.getUint32(5),
    totalLength: dv.getUint32(9),
    index: dv.getUint32(13),
    payload: bytes.subarray(HEADER_SIZE),
  };
}

// --- Decoder (online Gaussian elimination over GF(2)) ------------------------

export class Decoder {
  constructor(transferId, totalLength, blockSize) {
    this.transferId = transferId;
    this.totalLength = totalLength;
    this.blockSize = blockSize;
    this.K = Math.max(1, Math.ceil(totalLength / blockSize));
    this.W = (this.K + 31) >>> 5;
    this.pivBits = new Array(this.K).fill(null); // pivot row bits, lowest set bit = column
    this.pivData = new Array(this.K).fill(null);
    this.rank = 0;
    this.seen = new Set();
    this.solved = false;
  }
  get done() { return this.rank === this.K; }
  get uniqueFrames() { return this.seen.size; }

  // Returns true if the frame was new (whether or not it added information).
  add(frame) {
    if (this.done || this.seen.has(frame.index)) return false;
    if (frame.payload.length !== this.blockSize) return false;
    this.seen.add(frame.index);
    const bits = rowForIndex(this.transferId, frame.index, this.K);
    const data = new Uint8Array(frame.payload); // aligned copy
    const W = this.W;
    for (let w = 0; w < W; w++) {
      while (bits[w]) {
        const c = (w << 5) + (31 - Math.clz32(bits[w] & -bits[w]));
        const pb = this.pivBits[c];
        if (!pb) {
          this.pivBits[c] = bits; this.pivData[c] = data; this.rank++;
          return true;
        }
        for (let j = w; j < W; j++) bits[j] ^= pb[j];
        xorInto(data, this.pivData[c]);
      }
    }
    return true; // linearly dependent: no new information
  }

  // Back-substitution. Async so a big file does not freeze the page.
  async result(yieldEvery = 64) {
    if (!this.done) return null;
    const K = this.K;
    if (!this.solved) {
      for (let c = K - 1, n = 0; c >= 0; c--, n++) {
        const bits = this.pivBits[c], data = this.pivData[c];
        bits[c >>> 5] &= ~(1 << (c & 31));
        for (let w = c >>> 5; w < this.W; w++) {
          while (bits[w]) {
            const low = bits[w] & -bits[w];
            const c2 = (w << 5) + (31 - Math.clz32(low));
            xorInto(data, this.pivData[c2]);
            bits[w] ^= low;
          }
        }
        if (yieldEvery && n % yieldEvery === yieldEvery - 1) await new Promise(r => setTimeout(r, 0));
      }
      this.solved = true;
    }
    const out = new Uint8Array(this.totalLength);
    for (let k = 0; k < K; k++) {
      const start = k * this.blockSize;
      out.set(this.pivData[k].subarray(0, Math.min(this.blockSize, this.totalLength - start)), start);
    }
    return out;
  }
}

export function randomTransferId() {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0] || 1;
}
