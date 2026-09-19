/**
 * Cross-Device Optical File Transfer Protocol (v1)
 */

export const PROTOCOL_HEADER = 'OFT1:';
export const PROTOCOL_VERSION = 1;
export const DEFAULT_CHUNK_SIZE = 220; // Raw bytes per chunk

export interface FramePacket {
  v: number;      // Protocol version
  id: string;     // Unique session transfer ID
  name: string;   // Original filename
  size: number;   // Total file size in bytes
  mime: string;   // File MIME type
  total: number;  // Total number of chunks
  seq: number;    // Chunk sequence index (0-indexed)
  crc: number;    // CRC32 of this chunk's binary data
  data: string;   // Base64 encoded chunk data
}

/**
 * Fast IEEE 802.3 CRC32 implementation
 */
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Safe binary <-> base64 conversion
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Split a file's binary buffer into transfer packets
 */
export function createFilePackets(
  fileBuffer: Uint8Array,
  fileName: string,
  fileMime: string = 'application/octet-stream',
  chunkSize: number = DEFAULT_CHUNK_SIZE
): FramePacket[] {
  const totalBytes = fileBuffer.byteLength;
  const totalChunks = Math.max(1, Math.ceil(totalBytes / chunkSize));
  
  // Random session transfer ID (8 alphanumeric characters)
  const transferId = Math.random().toString(36).substring(2, 10);
  const packets: FramePacket[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, totalBytes);
    const chunkBytes = fileBuffer.slice(start, end);
    const chunkCrc = crc32(chunkBytes);
    const chunkBase64 = bytesToBase64(chunkBytes);

    packets.push({
      v: PROTOCOL_VERSION,
      id: transferId,
      name: fileName,
      size: totalBytes,
      mime: fileMime || 'application/octet-stream',
      total: totalChunks,
      seq: i,
      crc: chunkCrc,
      data: chunkBase64
    });
  }

  return packets;
}

/**
 * Serialize packet into string for QR code embedding
 */
export function serializePacket(packet: FramePacket): string {
  return PROTOCOL_HEADER + JSON.stringify(packet);
}

/**
 * Parse and validate QR string into FramePacket
 */
export function parsePacket(rawString: string): FramePacket | null {
  if (!rawString || typeof rawString !== 'string') return null;
  
  let jsonStr = rawString;
  if (rawString.startsWith(PROTOCOL_HEADER)) {
    jsonStr = rawString.slice(PROTOCOL_HEADER.length);
  } else {
    // If user scanned raw JSON without header, check if it's our format
    if (!rawString.trim().startsWith('{')) return null;
  }

  try {
    const obj = JSON.parse(jsonStr);
    if (
      obj &&
      typeof obj.v === 'number' &&
      typeof obj.id === 'string' &&
      typeof obj.name === 'string' &&
      typeof obj.size === 'number' &&
      typeof obj.total === 'number' &&
      typeof obj.seq === 'number' &&
      typeof obj.crc === 'number' &&
      typeof obj.data === 'string'
    ) {
      // Validate CRC integrity
      const chunkBytes = base64ToBytes(obj.data);
      const computedCrc = crc32(chunkBytes);
      if (computedCrc !== obj.crc) {
        console.warn(`[Protocol] CRC mismatch for chunk ${obj.seq}: expected ${obj.crc}, computed ${computedCrc}`);
        return null;
      }

      return obj as FramePacket;
    }
  } catch (err) {
    // Not a valid packet JSON
    return null;
  }

  return null;
}

export interface TransferProgress {
  sessionId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  receivedCount: number;
  percentage: number;
  isComplete: boolean;
  missingChunks: number[];
  receivedIndices: number[];
}

/**
 * Manages chunk collection and file reconstruction
 */
export class TransferAssembler {
  private sessionId: string | null = null;
  private fileName: string = '';
  private fileSize: number = 0;
  private mimeType: string = 'application/octet-stream';
  private totalChunks: number = 0;
  private receivedChunks = new Map<number, Uint8Array>();

  /**
   * Feed a decoded packet into assembler.
   * Returns true if packet was accepted as a new valid chunk.
   */
  public addPacket(packet: FramePacket): { accepted: boolean; isNew: boolean; isComplete: boolean } {
    // If new session or fresh start
    if (!this.sessionId || this.sessionId !== packet.id) {
      this.reset();
      this.sessionId = packet.id;
      this.fileName = packet.name;
      this.fileSize = packet.size;
      this.mimeType = packet.mime;
      this.totalChunks = packet.total;
    }

    if (this.receivedChunks.has(packet.seq)) {
      return { accepted: true, isNew: false, isComplete: this.isComplete() };
    }

    const chunkBytes = base64ToBytes(packet.data);
    this.receivedChunks.set(packet.seq, chunkBytes);

    return {
      accepted: true,
      isNew: true,
      isComplete: this.isComplete()
    };
  }

  public isComplete(): boolean {
    return this.totalChunks > 0 && this.receivedChunks.size === this.totalChunks;
  }

  public getProgress(): TransferProgress {
    const receivedCount = this.receivedChunks.size;
    const percentage = this.totalChunks > 0 ? Math.round((receivedCount / this.totalChunks) * 100) : 0;
    
    const missingChunks: number[] = [];
    for (let i = 0; i < this.totalChunks; i++) {
      if (!this.receivedChunks.has(i)) {
        missingChunks.push(i);
      }
    }

    const receivedIndices = Array.from(this.receivedChunks.keys()).sort((a, b) => a - b);

    return {
      sessionId: this.sessionId || '',
      fileName: this.fileName,
      fileSize: this.fileSize,
      mimeType: this.mimeType,
      totalChunks: this.totalChunks,
      receivedCount,
      percentage,
      isComplete: this.isComplete(),
      missingChunks,
      receivedIndices
    };
  }

  /**
   * Reassemble the full file buffer and blob
   */
  public reconstruct(): { fileBuffer: Uint8Array; blob: Blob; fileName: string; mimeType: string } | null {
    if (!this.isComplete()) return null;

    const fullBuffer = new Uint8Array(this.fileSize);
    let offset = 0;

    for (let i = 0; i < this.totalChunks; i++) {
      const chunk = this.receivedChunks.get(i);
      if (!chunk) {
        console.error(`[Assembler] Missing chunk ${i} during reconstruction`);
        return null;
      }
      fullBuffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const blob = new Blob([fullBuffer], { type: this.mimeType || 'application/octet-stream' });

    return {
      fileBuffer: fullBuffer,
      blob,
      fileName: this.fileName,
      mimeType: this.mimeType
    };
  }

  public reset() {
    this.sessionId = null;
    this.fileName = '';
    this.fileSize = 0;
    this.mimeType = 'application/octet-stream';
    this.totalChunks = 0;
    this.receivedChunks.clear();
  }
}
