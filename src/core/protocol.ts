/**
 * Decimen Optical Protocol (Wire v3) with Systematic-Carousel Fountain Code.
 * 
 * High-speed binary optical air-gap transfer engine.
 * Self-describing 22-byte header + binary QR mode (no Base64, no JSON bloat).
 * Includes Gzip compression, SHA-256 verification, and robust LTEncoder / LTDecoder.
 */

export const HEADER_LEN = 22;
export const MAGIC0 = 0xd1;
export const MAGIC1 = 0xc3;
export const WIRE_VERSION = 3;
export const CRITICAL_FLAGS = 0x0f;
export const SUPPORTED_FLAGS = 0x00;

export const DEFAULT_FRAME_BYTES = 1465; // ~V27 QR Code, optimal sweet spot
export const FRAME_BYTES_OPTIONS = [600, 1000, 1465, 2000, 2953] as const;

export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_LABEL = '64 MB';
export const FILE_HEADER_LEN = 49;
export const FILE_MAGIC = new Uint8Array([0x44, 0x43, 0x46, 0x32]); // DCF2

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type CompressionMode = 'none' | 'gzip';

export interface PackedOpticalFile {
  container: Uint8Array;
  compression: CompressionMode;
  originalSize: number;
  transmittedSize: number;
}

export interface OpticalFile {
  name: string;
  type: string;
  bytes: Uint8Array;
  sha256: Uint8Array;
  compression: CompressionMode;
  transmittedSize: number;
}

export interface FrameHeader {
  sessionId: number;
  seq: number;
  k: number;
  blockLen: number;
  totalLen: number;
  payloadFnv: number;
  flags: number;
}

export type FrameVerdict =
  | { kind: 'ok' }
  | { kind: 'foreign' }
  | { kind: 'older-sender'; version: number }
  | { kind: 'newer-sender'; version: number }
  | { kind: 'unsupported-flags'; flags: number }
  | { kind: 'malformed' };

/** Media types whose bytes are already compressed (skip gzip attempt) */
const PRECOMPRESSED_TYPES = new Set([
  'application/gzip',
  'application/java-archive',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-brotli',
  'application/x-bzip',
  'application/x-bzip2',
  'application/x-gzip',
  'application/x-lzma',
  'application/x-rar-compressed',
  'application/x-xz',
  'application/x-zip-compressed',
  'application/zip',
  'application/zstd',
]);

const COMPRESSIBLE_IMAGES = /^image\/(bmp|x-ms-bmp|svg\+xml|tiff|x-icon|vnd\.microsoft\.icon)$/;
const COMPRESSIBLE_AUDIO = /^audio\/(wav|x-wav|wave|vnd\.wave|aiff|x-aiff|basic|l16)$/;

export function isPrecompressedType(type: string): boolean {
  const media = type.split(';')[0]!.trim().toLowerCase();
  if (media.startsWith('video/')) return true;
  if (media.startsWith('image/')) return !COMPRESSIBLE_IMAGES.test(media);
  if (media.startsWith('audio/')) return !COMPRESSIBLE_AUDIO.test(media);
  if (media.startsWith('application/vnd.openxmlformats-officedocument.')) return true;
  if (media.startsWith('application/vnd.oasis.opendocument.')) return true;
  if (media.endsWith('+zip')) return true;
  return PRECOMPRESSED_TYPES.has(media);
}

export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'transfer.bin' : cleaned;
}

export async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  const stableBytes = Uint8Array.from(bytes);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', stableBytes));
}

export async function gzipAsync(bytes: Uint8Array): Promise<Uint8Array> {
  const compressed = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

export async function gunzipAsync(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const inflated = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const reader = inflated.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Inflate overflow: payload exceeds declared bounds');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function packFile(
  name: string,
  type: string,
  bytes: Uint8Array
): Promise<PackedOpticalFile> {
  if (bytes.length === 0) throw new Error('Cannot pack empty file');
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`Files are limited to ${MAX_FILE_LABEL}`);
  }

  const nameBytes = textEncoder.encode(safeFileName(name));
  const typeBytes = textEncoder.encode(type || 'application/octet-stream');
  if (nameBytes.length > 0xffff || typeBytes.length > 0xffff) {
    throw new Error('File name or type too long');
  }

  const tryGzip = bytes.length >= 768 && !isPrecompressedType(type);
  const [sha256, compressed] = await Promise.all([
    digest(bytes),
    tryGzip ? gzipAsync(bytes).catch(() => undefined) : Promise.resolve(undefined),
  ]);

  const useGzip = compressed !== undefined && compressed.length + 64 < bytes.length;
  const transmitted = useGzip ? compressed : bytes;
  const compression: CompressionMode = useGzip ? 'gzip' : 'none';

  const out = new Uint8Array(
    FILE_HEADER_LEN + nameBytes.length + typeBytes.length + transmitted.length
  );
  const view = new DataView(out.buffer);

  out.set(FILE_MAGIC, 0);
  view.setUint8(4, useGzip ? 1 : 0);
  view.setUint16(5, nameBytes.length, true);
  view.setUint16(7, typeBytes.length, true);
  view.setUint32(9, bytes.length, true);
  view.setUint32(13, transmitted.length, true);
  out.set(sha256, 17);
  out.set(nameBytes, FILE_HEADER_LEN);
  out.set(typeBytes, FILE_HEADER_LEN + nameBytes.length);
  out.set(transmitted, FILE_HEADER_LEN + nameBytes.length + typeBytes.length);

  return {
    container: out,
    compression,
    originalSize: bytes.length,
    transmittedSize: transmitted.length,
  };
}

export async function unpackFile(container: Uint8Array): Promise<OpticalFile> {
  if (container.length < FILE_HEADER_LEN) throw new Error('Container truncated');
  for (let i = 0; i < FILE_MAGIC.length; i++) {
    if (container[i] !== FILE_MAGIC[i]) throw new Error('Container bad magic');
  }

  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const compressionByte = view.getUint8(4);
  const compression: CompressionMode = compressionByte === 1 ? 'gzip' : 'none';
  const nameLength = view.getUint16(5, true);
  const typeLength = view.getUint16(7, true);
  const fileLength = view.getUint32(9, true);
  const transmittedLength = view.getUint32(13, true);
  const dataOffset = FILE_HEADER_LEN + nameLength + typeLength;

  if (
    fileLength === 0 ||
    fileLength > MAX_FILE_BYTES ||
    transmittedLength === 0 ||
    dataOffset + transmittedLength !== container.length
  ) {
    throw new Error('Container length mismatch');
  }

  const transmitted = container.slice(dataOffset);
  const bytes = compression === 'gzip' ? await gunzipAsync(transmitted, fileLength) : transmitted;
  if (bytes.length !== fileLength) {
    throw new Error('Decompressed length mismatch');
  }

  return {
    name: safeFileName(
      textDecoder.decode(container.subarray(FILE_HEADER_LEN, FILE_HEADER_LEN + nameLength))
    ),
    type:
      textDecoder.decode(container.subarray(FILE_HEADER_LEN + nameLength, dataOffset)) ||
      'application/octet-stream',
    sha256: container.slice(17, 49),
    bytes,
    compression,
    transmittedSize: transmittedLength,
  };
}

export async function verifyFile(file: OpticalFile): Promise<boolean> {
  const actual = await digest(file.bytes);
  return actual.every((value, index) => value === file.sha256[index]);
}

export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function splitmix32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

export function blockLength(frameBytes: number): number {
  return frameBytes - HEADER_LEN;
}

export function sourceBlockCount(payloadBytes: number, frameBytes: number): number {
  return Math.max(1, Math.ceil(payloadBytes / blockLength(frameBytes)));
}

export function fitsInOneStream(payloadBytes: number, frameBytes: number): boolean {
  return sourceBlockCount(payloadBytes, frameBytes) <= 0xffff;
}

export function cycleLength(k: number): number {
  return 2 * k;
}

function frameSeed(sessionId: number, seq: number): number {
  let h = (Math.imul(sessionId + 1, 0x9e3779b1) ^ (seq + 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) | 0;
}

const REPAIR_DEGREE_MIN = 4;
const REPAIR_DEGREE_MAX = 24;

function repairIndices(k: number, sessionId: number, seq: number): number[] {
  const rnd = splitmix32(frameSeed(sessionId, seq));
  const d = Math.min(k, REPAIR_DEGREE_MIN + (rnd() % (REPAIR_DEGREE_MAX - REPAIR_DEGREE_MIN + 1)));
  const set = new Set<number>();
  while (set.size < d) set.add(rnd() % k);
  return [...set];
}

export function frameComposition(k: number, sessionId: number, seq: number): number[] {
  const pos = seq % cycleLength(k);
  return pos < k ? [pos] : repairIndices(k, sessionId, seq);
}

function xorInto(dst: Uint32Array, src: Uint32Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] = (dst[i]! ^ src[i]!) >>> 0;
}

export class LTEncoder {
  readonly k: number;
  private readonly words: number;
  private readonly blocks: Uint32Array;

  constructor(
    payload: Uint8Array,
    readonly blockLen: number,
    readonly sessionId: number
  ) {
    this.k = Math.max(1, Math.ceil(payload.length / blockLen));
    this.words = Math.ceil(blockLen / 4);
    this.blocks = new Uint32Array(this.k * this.words);
    const bytes = new Uint8Array(this.blocks.buffer);
    for (let b = 0; b < this.k; b++) {
      const src = payload.subarray(b * blockLen, Math.min((b + 1) * blockLen, payload.length));
      bytes.set(src, b * this.words * 4);
    }
  }

  encode(seq: number): Uint8Array {
    const idx = frameComposition(this.k, this.sessionId, seq);
    const out = new Uint32Array(this.words);
    for (const b of idx) {
      const off = b * this.words;
      for (let w = 0; w < this.words; w++) out[w] = (out[w]! ^ this.blocks[off + w]!) >>> 0;
    }
    return new Uint8Array(out.buffer, 0, this.blockLen);
  }
}

interface PendingFrame {
  idx: Set<number>;
  words: Uint32Array;
}

export class LTDecoder {
  private readonly words: number;
  private readonly solved: (Uint32Array | null)[];
  private readonly byBlock = new Map<number, Set<PendingFrame>>();
  private readonly seen = new Set<number>();
  solvedCount = 0;
  framesNew = 0;
  framesDup = 0;
  framesRedundant = 0;

  constructor(
    readonly k: number,
    readonly blockLen: number,
    readonly sessionId: number,
    readonly totalLen: number
  ) {
    this.words = Math.ceil(blockLen / 4);
    this.solved = new Array<Uint32Array | null>(k).fill(null);
  }

  get isComplete(): boolean {
    return this.solvedCount >= this.k;
  }

  addFrame(seq: number, block: Uint8Array): void {
    if (this.seen.has(seq)) {
      this.framesDup++;
      return;
    }
    this.seen.add(seq);
    this.framesNew++;
    if (this.isComplete) return;

    const idx = new Set(frameComposition(this.k, this.sessionId, seq));
    const words = new Uint32Array(this.words);
    new Uint8Array(words.buffer).set(block.subarray(0, this.blockLen));

    for (const b of [...idx]) {
      const s = this.solved[b];
      if (s) {
        xorInto(words, s);
        idx.delete(b);
      }
    }

    if (idx.size === 0) {
      this.framesRedundant++;
      return;
    }

    if (idx.size === 1) {
      this.resolve(idx.values().next().value!, words);
      return;
    }

    const pf: PendingFrame = { idx, words };
    for (const b of idx) {
      let set = this.byBlock.get(b);
      if (!set) {
        set = new Set();
        this.byBlock.set(b, set);
      }
      set.add(pf);
    }
  }

  private resolve(b0: number, w0: Uint32Array): void {
    const queue: [number, Uint32Array][] = [[b0, w0]];
    while (queue.length > 0) {
      const [b, w] = queue.pop()!;
      if (this.solved[b]) continue;
      this.solved[b] = w;
      this.solvedCount++;
      const waiting = this.byBlock.get(b);
      if (!waiting) continue;
      this.byBlock.delete(b);
      for (const pf of waiting) {
        xorInto(pf.words, w);
        pf.idx.delete(b);
        if (pf.idx.size === 1) {
          const r = pf.idx.values().next().value!;
          this.byBlock.get(r)?.delete(pf);
          if (!this.solved[r]) queue.push([r, pf.words]);
        }
      }
    }
  }

  assemble(): Uint8Array | null {
    if (!this.isComplete) return null;
    const out = new Uint8Array(this.totalLen);
    for (let b = 0; b < this.k; b++) {
      const start = b * this.blockLen;
      const len = Math.min(this.blockLen, this.totalLen - start);
      if (len > 0) out.set(new Uint8Array(this.solved[b]!.buffer, 0, len), start);
    }
    return out;
  }
}

export function packFrame(h: FrameHeader, block: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + block.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, MAGIC0);
  dv.setUint8(1, MAGIC1);
  dv.setUint8(2, WIRE_VERSION);
  dv.setUint8(3, h.flags);
  dv.setUint16(4, h.sessionId, true);
  dv.setUint32(6, h.seq, true);
  dv.setUint16(10, h.k, true);
  dv.setUint16(12, h.blockLen, true);
  dv.setUint32(14, h.totalLen, true);
  dv.setUint32(18, h.payloadFnv, true);
  out.set(block, HEADER_LEN);
  return out;
}

export function classifyFrame(bytes: Uint8Array): FrameVerdict {
  if (bytes.length < 4 || bytes[0] !== MAGIC0) return { kind: 'foreign' };
  if (bytes[1] !== MAGIC1) return { kind: 'foreign' };

  const version = bytes[2]!;
  if (version === 0) return { kind: 'malformed' };
  if (version !== WIRE_VERSION) {
    return version > WIRE_VERSION
      ? { kind: 'newer-sender', version }
      : { kind: 'older-sender', version };
  }

  const unknownCritical = bytes[3]! & CRITICAL_FLAGS & ~SUPPORTED_FLAGS;
  if (unknownCritical !== 0) return { kind: 'unsupported-flags', flags: unknownCritical };
  if (bytes.length <= HEADER_LEN) return { kind: 'malformed' };

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const k = dv.getUint16(10, true);
  const blockLen = dv.getUint16(12, true);
  const totalLen = dv.getUint32(14, true);
  if (k === 0 || blockLen === 0 || totalLen === 0) return { kind: 'malformed' };
  if (bytes.length !== HEADER_LEN + blockLen) return { kind: 'malformed' };

  return { kind: 'ok' };
}

export function parseFrame(
  bytes: Uint8Array
): { header: FrameHeader; block: Uint8Array } | null {
  if (classifyFrame(bytes).kind !== 'ok') return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: FrameHeader = {
    sessionId: dv.getUint16(4, true),
    seq: dv.getUint32(6, true),
    k: dv.getUint16(10, true),
    blockLen: dv.getUint16(12, true),
    totalLen: dv.getUint32(14, true),
    payloadFnv: dv.getUint32(18, true),
    flags: dv.getUint8(3),
  };
  return { header, block: bytes.subarray(HEADER_LEN) };
}

export function streamIdentity(h: FrameHeader): string {
  const critical = h.flags & CRITICAL_FLAGS;
  return `${h.sessionId}:${h.k}:${h.blockLen}:${h.totalLen}:${h.payloadFnv}:${critical}`;
}

export function getFileExtension(filename: string): string {
  const parts = filename.split('.');
  return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
}
