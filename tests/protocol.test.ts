import { describe, it, expect } from 'vitest';
import {
  createTransferPackets,
  serializePacket,
  parsePacket,
  TransferAssembler,
  crc32,
  bytesToBase64,
  base64ToBytes,
  getFileExtension,
  TransferStartPacket,
  DataFramePacket,
  TransferEndPacket
} from '../src/core/protocol';

describe('Phase 2 Proper Transfer Protocol', () => {
  it('should roundtrip binary data to base64 correctly', () => {
    const original = new Uint8Array([0, 1, 2, 254, 255, 128, 64, 32, 16, 8, 4, 2, 1]);
    const b64 = bytesToBase64(original);
    const decoded = base64ToBytes(b64);
    expect(decoded).toEqual(original);
  });

  it('should correctly extract file extensions', () => {
    expect(getFileExtension('archive.tar.gz')).toBe('gz');
    expect(getFileExtension('photo.PNG')).toBe('png');
    expect(getFileExtension('document.pdf')).toBe('pdf');
    expect(getFileExtension('no_ext')).toBe('');
  });

  it('should generate structured START, DATA, and END frames with all required fields', () => {
    const textData = 'Structured Optical Communication Frame Protocol Phase 2 Verification'.repeat(10);
    const buffer = new TextEncoder().encode(textData);
    const chunkSize = 200;

    const packets = createTransferPackets(buffer, 'report.pdf', 'application/pdf', chunkSize);
    
    // First frame must be TRANSFER_START
    const startPacket = packets[0] as TransferStartPacket;
    expect(startPacket.type).toBe('TRANSFER_START');
    expect(startPacket.protocol_version).toBe(2);
    expect(startPacket.transfer_id).toBeDefined();
    expect(startPacket.filename).toBe('report.pdf');
    expect(startPacket.file_ext).toBe('pdf');
    expect(startPacket.mime_type).toBe('application/pdf');
    expect(startPacket.file_size).toBe(buffer.byteLength);
    expect(startPacket.chunk_size).toBe(chunkSize);
    expect(startPacket.total_chunks).toBe(Math.ceil(buffer.byteLength / chunkSize));
    expect(startPacket.file_checksum).toBe(crc32(buffer));

    // Middle frames must be DATA_FRAME
    const totalDataFrames = startPacket.total_chunks;
    for (let i = 0; i < totalDataFrames; i++) {
      const dataPacket = packets[i + 1] as DataFramePacket;
      expect(dataPacket.type).toBe('DATA_FRAME');
      expect(dataPacket.transfer_id).toBe(startPacket.transfer_id);
      expect(dataPacket.seq).toBe(i);
      expect(dataPacket.chunk_id).toBe(`${startPacket.transfer_id}_c${i}`);
      expect(dataPacket.total_chunks).toBe(totalDataFrames);
      expect(dataPacket.crc).toBeDefined();
      expect(dataPacket.payload).toBeDefined();
    }

    // Last frame must be TRANSFER_END
    const endPacket = packets[packets.length - 1] as TransferEndPacket;
    expect(endPacket.type).toBe('TRANSFER_END');
    expect(endPacket.protocol_version).toBe(2);
    expect(endPacket.transfer_id).toBe(startPacket.transfer_id);
    expect(endPacket.total_chunks).toBe(totalDataFrames);
    expect(endPacket.checksum).toBe(startPacket.file_checksum);
  });

  it('should serialize and deserialize all 3 frame types with integrity verification', () => {
    const buffer = new TextEncoder().encode('Test Data Payload Frame');
    const packets = createTransferPackets(buffer, 'test.txt', 'text/plain', 50);

    for (const packet of packets) {
      const serialized = serializePacket(packet);
      expect(serialized.startsWith('LUMA2:')).toBe(true);

      const parsed = parsePacket(serialized);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe(packet.type);
      expect(parsed?.transfer_id).toBe(packet.transfer_id);
    }
  });

  it('should REJECT frames belonging to a different transfer ID', () => {
    const fileA = new TextEncoder().encode('File A Contents');
    const fileB = new TextEncoder().encode('File B Different Session Contents');

    const packetsA = createTransferPackets(fileA, 'fileA.txt', 'text/plain', 100);
    const packetsB = createTransferPackets(fileB, 'fileB.txt', 'text/plain', 100);

    expect(packetsA[0].transfer_id).not.toBe(packetsB[0].transfer_id);

    const assembler = new TransferAssembler();

    // 1. Ingest transfer A start frame
    const resA1 = assembler.addPacket(packetsA[0]);
    expect(resA1.accepted).toBe(true);
    expect(assembler.getProgress().transferId).toBe(packetsA[0].transfer_id);

    // 2. Attempt to inject a frame from transfer B
    const resB = assembler.addPacket(packetsB[1]); // Foreign data chunk
    expect(resB.accepted).toBe(false);
    expect(resB.rejectedReason).toContain('different transfer');
    expect(assembler.getProgress().rejectedCount).toBe(1);
    expect(assembler.getProgress().lastRejectedTransferId).toBe(packetsB[0].transfer_id);

    // 3. Continue feeding transfer A frames: should still accept transfer A
    const resA2 = assembler.addPacket(packetsA[1]);
    expect(resA2.accepted).toBe(true);
    expect(assembler.getProgress().receivedCount).toBe(1);
  });

  it('should reject corrupted chunk payload CRC', () => {
    const file = new TextEncoder().encode('Integrity critical document');
    const packets = createTransferPackets(file, 'doc.txt', 'text/plain', 100);
    const dataFrame = packets[1] as DataFramePacket;

    // Tamper with data packet CRC
    dataFrame.crc = dataFrame.crc ^ 0x9999;
    const serialized = serializePacket(dataFrame);
    const parsed = parsePacket(serialized);
    expect(parsed).toBeNull(); // parsePacket discards corrupted chunk
  });

  it('should reassemble full file and verify whole-file checksum', () => {
    const rawBytes = new Uint8Array(800);
    for (let i = 0; i < 800; i++) rawBytes[i] = (i * 17) % 256;

    const packets = createTransferPackets(rawBytes, 'dataset.bin', 'application/octet-stream', 150);
    const assembler = new TransferAssembler();

    // Shuffle packets out of order (e.g. data frames first, then start, then end)
    const shuffled = [...packets].sort(() => Math.random() - 0.5);

    for (const p of shuffled) {
      assembler.addPacket(p);
    }

    expect(assembler.isComplete()).toBe(true);
    const reconstructed = assembler.reconstruct();
    expect(reconstructed).not.toBeNull();
    expect(reconstructed?.fileName).toBe('dataset.bin');
    expect(reconstructed?.fileExt).toBe('bin');
    expect(reconstructed?.fileBuffer).toEqual(rawBytes);
    expect(reconstructed?.checksum).toBe(crc32(rawBytes));
  });
});
