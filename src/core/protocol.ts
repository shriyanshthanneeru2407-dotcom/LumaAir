/**
 * Cross-Device Optical File Transfer Protocol (v2) — Luma
 * Structured multi-frame protocol with START, DATA, and END frames.
 */

export const PROTOCOL_HEADER = 'LUMA2:';
export const PROTOCOL_VERSION = 2;
export const DEFAULT_CHUNK_SIZE = 220; // Raw bytes per chunk

export type PacketType = 'TRANSFER_START' | 'DATA_FRAME' | 'TRANSFER_END';

/**
 * 1. TRANSFER_START Frame
 * Transmitted before data frames to initialize transfer metadata.
 */
export interface TransferStartPacket {
  type: 'TRANSFER_START';
  protocol_version: number;
  transfer_id: string;
  filename: string;
  file_ext: string;
  mime_type: string;
  file_size: number;
  chunk_size: number;
  total_chunks: number;
  file_checksum: number; // CRC32 of full file
}

/**
 * 2. DATA_FRAME Frame
 * Transmitted for each chunk of data.
 */
export interface DataFramePacket {
  type: 'DATA_FRAME';
  protocol_version: number;
  transfer_id: string;
  chunk_id: string; // Unique chunk ID (e.g. transferId_chunk_seq)
  seq: number;      // 0-indexed sequence number
  total_chunks: number;
  payload: string;  // Base64 encoded payload
  crc: number;      // CRC32 of this chunk's raw bytes
}

/**
 * 3. TRANSFER_END Frame
 * Transmitted after all data frames to mark transfer completion.
 */
export interface TransferEndPacket {
  type: 'TRANSFER_END';
  protocol_version: number;
  transfer_id: string;
  total_chunks: number;
  checksum: number; // CRC32 of full file
}

export type ProtocolPacket = TransferStartPacket | DataFramePacket | TransferEndPacket;

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
 * Extract clean file extension from a filename
 */
export function getFileExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex !== -1 && dotIndex < filename.length - 1) {
    return filename.substring(dotIndex + 1).toLowerCase();
  }
  return '';
}

/**
 * Create structured Phase 2 transmission packets:
 * 1. TRANSFER_START
 * 2. DATA_FRAME (0 to N-1)
 * 3. TRANSFER_END
 */
export function createTransferPackets(
  fileBuffer: Uint8Array,
  fileName: string,
  fileMime: string = 'application/octet-stream',
  chunkSize: number = DEFAULT_CHUNK_SIZE
): ProtocolPacket[] {
  const totalBytes = fileBuffer.byteLength;
  const totalChunks = Math.max(1, Math.ceil(totalBytes / chunkSize));
  const fileExt = getFileExtension(fileName);
  const fileChecksum = crc32(fileBuffer);
  
  // Random session transfer ID (8 alphanumeric characters)
  const transferId = Math.random().toString(36).substring(2, 10);
  const packets: ProtocolPacket[] = [];

  // Frame 0: TRANSFER_START
  const startPacket: TransferStartPacket = {
    type: 'TRANSFER_START',
    protocol_version: PROTOCOL_VERSION,
    transfer_id: transferId,
    filename: fileName,
    file_ext: fileExt,
    mime_type: fileMime || 'application/octet-stream',
    file_size: totalBytes,
    chunk_size: chunkSize,
    total_chunks: totalChunks,
    file_checksum: fileChecksum
  };
  packets.push(startPacket);

  // Frames 1..N: DATA_FRAME
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, totalBytes);
    const chunkBytes = fileBuffer.slice(start, end);
    const chunkCrc = crc32(chunkBytes);
    const chunkBase64 = bytesToBase64(chunkBytes);

    const dataPacket: DataFramePacket = {
      type: 'DATA_FRAME',
      protocol_version: PROTOCOL_VERSION,
      transfer_id: transferId,
      chunk_id: `${transferId}_c${i}`,
      seq: i,
      total_chunks: totalChunks,
      payload: chunkBase64,
      crc: chunkCrc
    };
    packets.push(dataPacket);
  }

  // Frame N+1: TRANSFER_END
  const endPacket: TransferEndPacket = {
    type: 'TRANSFER_END',
    protocol_version: PROTOCOL_VERSION,
    transfer_id: transferId,
    total_chunks: totalChunks,
    checksum: fileChecksum
  };
  packets.push(endPacket);

  return packets;
}

/**
 * Serialize packet into string for QR code embedding
 */
export function serializePacket(packet: ProtocolPacket): string {
  return PROTOCOL_HEADER + JSON.stringify(packet);
}

/**
 * Parse and validate QR string into a ProtocolPacket
 */
export function parsePacket(rawString: string): ProtocolPacket | null {
  if (!rawString || typeof rawString !== 'string') return null;

  let jsonStr = rawString;
  if (rawString.startsWith(PROTOCOL_HEADER)) {
    jsonStr = rawString.slice(PROTOCOL_HEADER.length);
  } else if (rawString.startsWith('OFT1:')) {
    // Backward compatibility for Phase 1 packets
    jsonStr = rawString.slice(5);
  } else {
    if (!rawString.trim().startsWith('{')) return null;
  }

  try {
    const obj = JSON.parse(jsonStr);
    if (!obj || typeof obj !== 'object') return null;

    // Phase 2 packet handling
    if (obj.type === 'TRANSFER_START') {
      if (
        typeof obj.transfer_id === 'string' &&
        typeof obj.filename === 'string' &&
        typeof obj.file_size === 'number' &&
        typeof obj.total_chunks === 'number' &&
        typeof obj.file_checksum === 'number'
      ) {
        return obj as TransferStartPacket;
      }
    } else if (obj.type === 'DATA_FRAME') {
      if (
        typeof obj.transfer_id === 'string' &&
        typeof obj.seq === 'number' &&
        typeof obj.payload === 'string' &&
        typeof obj.crc === 'number'
      ) {
        // Validate chunk CRC
        const chunkBytes = base64ToBytes(obj.payload);
        const computedCrc = crc32(chunkBytes);
        if (computedCrc !== obj.crc) {
          console.warn(`[Protocol] Chunk CRC mismatch for seq ${obj.seq}: expected ${obj.crc}, got ${computedCrc}`);
          return null;
        }
        return obj as DataFramePacket;
      }
    } else if (obj.type === 'TRANSFER_END') {
      if (
        typeof obj.transfer_id === 'string' &&
        typeof obj.total_chunks === 'number' &&
        typeof obj.checksum === 'number'
      ) {
        return obj as TransferEndPacket;
      }
    } else if (obj.v === 1 && typeof obj.id === 'string' && typeof obj.seq === 'number') {
      // Legacy Phase 1 format adapter
      const chunkBytes = base64ToBytes(obj.data);
      if (crc32(chunkBytes) !== obj.crc) return null;
      const converted: DataFramePacket = {
        type: 'DATA_FRAME',
        protocol_version: 1,
        transfer_id: obj.id,
        chunk_id: `${obj.id}_c${obj.seq}`,
        seq: obj.seq,
        total_chunks: obj.total,
        payload: obj.data,
        crc: obj.crc
      };
      return converted;
    }
  } catch {
    return null;
  }

  return null;
}

export interface TransferProgress {
  transferId: string;
  fileName: string;
  fileExt: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  receivedCount: number;
  percentage: number;
  isComplete: boolean;
  hasStartHeader: boolean;
  hasEndMarker: boolean;
  missingChunks: number[];
  receivedIndices: number[];
  rejectedCount: number;
  lastRejectedTransferId: string | null;
}

export interface AddPacketResult {
  accepted: boolean;
  isNew: boolean;
  isComplete: boolean;
  rejectedReason?: string;
  packetType: PacketType;
}

/**
 * Manages chunk collection, strict session isolation, and verified file reconstruction
 */
export class TransferAssembler {
  private activeTransferId: string | null = null;
  private header: TransferStartPacket | null = null;
  private endPacket: TransferEndPacket | null = null;
  private expectedTotalChunks: number = 0;
  private expectedFileSize: number = 0;
  private receivedChunks = new Map<number, Uint8Array>();
  private rejectedCount: number = 0;
  private lastRejectedTransferId: string | null = null;

  /**
   * Feed a decoded packet into assembler.
   * Enforces session locking: rejects frames belonging to a different transfer ID!
   */
  public addPacket(packet: ProtocolPacket): AddPacketResult {
    const packetTransferId = packet.transfer_id;

    // Reject frames belonging to a different transfer
    if (this.activeTransferId !== null && packetTransferId !== this.activeTransferId) {
      this.rejectedCount++;
      this.lastRejectedTransferId = packetTransferId;
      console.warn(`[Assembler] Rejected frame from foreign transfer ${packetTransferId} (active: ${this.activeTransferId})`);
      return {
        accepted: false,
        isNew: false,
        isComplete: false,
        rejectedReason: `Belongs to different transfer ${packetTransferId} (locked to ${this.activeTransferId})`,
        packetType: packet.type
      };
    }

    // First frame encountered locks the active session ID
    if (this.activeTransferId === null) {
      this.activeTransferId = packetTransferId;
    }

    let isNew = false;

    if (packet.type === 'TRANSFER_START') {
      if (!this.header) {
        this.header = packet;
        this.expectedTotalChunks = packet.total_chunks;
        this.expectedFileSize = packet.file_size;
        isNew = true;
      }
    } else if (packet.type === 'DATA_FRAME') {
      if (this.expectedTotalChunks === 0 && packet.total_chunks > 0) {
        this.expectedTotalChunks = packet.total_chunks;
      }

      if (!this.receivedChunks.has(packet.seq)) {
        const chunkBytes = base64ToBytes(packet.payload);
        this.receivedChunks.set(packet.seq, chunkBytes);
        isNew = true;
      }
    } else if (packet.type === 'TRANSFER_END') {
      if (!this.endPacket) {
        this.endPacket = packet;
        if (this.expectedTotalChunks === 0) {
          this.expectedTotalChunks = packet.total_chunks;
        }
        isNew = true;
      }
    }

    return {
      accepted: true,
      isNew,
      isComplete: this.isComplete(),
      packetType: packet.type
    };
  }

  public isComplete(): boolean {
    if (this.expectedTotalChunks === 0) return false;
    if (this.receivedChunks.size !== this.expectedTotalChunks) return false;

    // Check integrity against expected file checksum
    const targetChecksum = this.header?.file_checksum ?? this.endPacket?.checksum;
    if (targetChecksum !== undefined) {
      const reconstructed = this.assembleBuffer();
      if (!reconstructed) return false;
      return crc32(reconstructed) === targetChecksum;
    }

    return true;
  }

  private assembleBuffer(): Uint8Array | null {
    if (this.expectedTotalChunks === 0 || this.receivedChunks.size !== this.expectedTotalChunks) {
      return null;
    }

    let calculatedSize = 0;
    for (let i = 0; i < this.expectedTotalChunks; i++) {
      const chunk = this.receivedChunks.get(i);
      if (!chunk) return null;
      calculatedSize += chunk.byteLength;
    }

    const fullBuffer = new Uint8Array(calculatedSize);
    let offset = 0;
    for (let i = 0; i < this.expectedTotalChunks; i++) {
      const chunk = this.receivedChunks.get(i)!;
      fullBuffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return fullBuffer;
  }

  public getProgress(): TransferProgress {
    const receivedCount = this.receivedChunks.size;
    const total = this.expectedTotalChunks;
    const percentage = total > 0 ? Math.round((receivedCount / total) * 100) : 0;

    const missingChunks: number[] = [];
    for (let i = 0; i < total; i++) {
      if (!this.receivedChunks.has(i)) {
        missingChunks.push(i);
      }
    }

    const receivedIndices = Array.from(this.receivedChunks.keys()).sort((a, b) => a - b);

    return {
      transferId: this.activeTransferId || '',
      fileName: this.header?.filename || 'Receiving stream...',
      fileExt: this.header?.file_ext || '',
      fileSize: this.expectedFileSize,
      mimeType: this.header?.mime_type || 'application/octet-stream',
      totalChunks: total,
      receivedCount,
      percentage,
      isComplete: this.isComplete(),
      hasStartHeader: this.header !== null,
      hasEndMarker: this.endPacket !== null,
      missingChunks,
      receivedIndices,
      rejectedCount: this.rejectedCount,
      lastRejectedTransferId: this.lastRejectedTransferId
    };
  }

  public reconstruct(): {
    fileBuffer: Uint8Array;
    blob: Blob;
    fileName: string;
    fileExt: string;
    mimeType: string;
    checksum: number;
    transferId: string;
  } | null {
    if (!this.isComplete()) return null;

    const fullBuffer = this.assembleBuffer();
    if (!fullBuffer) return null;

    const computedChecksum = crc32(fullBuffer);
    const targetChecksum = this.header?.file_checksum ?? this.endPacket?.checksum;
    if (targetChecksum !== undefined && computedChecksum !== targetChecksum) {
      console.error(`[Assembler] Integrity mismatch: expected ${targetChecksum}, got ${computedChecksum}`);
      return null;
    }

    const fileName = this.header?.filename || `transfer_${this.activeTransferId}.bin`;
    const mimeType = this.header?.mime_type || 'application/octet-stream';
    const fileExt = this.header?.file_ext || getFileExtension(fileName);
    const blob = new Blob([fullBuffer as BlobPart], { type: mimeType });

    return {
      fileBuffer: fullBuffer,
      blob,
      fileName,
      fileExt,
      mimeType,
      checksum: computedChecksum,
      transferId: this.activeTransferId || ''
    };
  }

  public reset() {
    this.activeTransferId = null;
    this.header = null;
    this.endPacket = null;
    this.expectedTotalChunks = 0;
    this.expectedFileSize = 0;
    this.receivedChunks.clear();
    this.rejectedCount = 0;
    this.lastRejectedTransferId = null;
  }
}
