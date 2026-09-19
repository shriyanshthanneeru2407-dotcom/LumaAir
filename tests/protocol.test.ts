import { describe, it, expect } from 'vitest';
import {
  createTransferPackets,
  createPairingPacket,
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

  it('should support Spatial Multiplexing: 16 packets ingested in a single parallel batch', () => {
    // Generate a file that breaks into 14 data chunks + 1 START + 1 END = exactly 16 packets!
    const dataSize = 14 * 100;
    const rawBytes = new Uint8Array(dataSize);
    for (let i = 0; i < dataSize; i++) rawBytes[i] = (i + 42) % 256;

    const packets = createTransferPackets(rawBytes, 'matrix_file.bin', 'application/octet-stream', 100);
    expect(packets.length).toBe(16); // Exactly fits in one 4x4 16-QR grid snapshot!

    const assembler = new TransferAssembler();

    // In a single camera tick, mobile BarcodeDetector returns all 16 packets simultaneously:
    let batchAccepted = 0;
    for (const p of packets) {
      const res = assembler.addPacket(p);
      if (res.accepted) batchAccepted++;
    }

    expect(batchAccepted).toBe(16);
    expect(assembler.isComplete()).toBe(true);

    const reconstructed = assembler.reconstruct();
    expect(reconstructed).not.toBeNull();
    expect(reconstructed?.fileBuffer.byteLength).toBe(dataSize);
    expect(reconstructed?.fileBuffer).toEqual(rawBytes);
  });

  it('should accurately calculate active and empty slot counts in 4x4 and 2x2 grid modes', async () => {
    const { OpticalSender } = await import('../src/core/sender');

    const sender = new OpticalSender({ gridMode: '4x4' });
    expect(sender.getPageSize()).toBe(16);

    // Mock a File with 10 chunks total (8 data + 1 START + 1 END = 10 packets)
    const content = new Uint8Array(8 * 100);
    const mockFile = {
      name: 'notes.txt',
      type: 'text/plain',
      size: content.byteLength,
      arrayBuffer: async () => content.buffer
    } as unknown as File;

    await sender.loadFile(mockFile, 100);

    const infoPage0 = sender.getFrameInfo();
    expect(infoPage0.totalFrames).toBe(10);
    expect(infoPage0.totalPages).toBe(1);
    expect(infoPage0.activeSlotsCount).toBe(10);
    expect(infoPage0.emptySlotsCount).toBe(6); // 16 - 10 = 6 empty slots!

    // Now test a file with 18 packets (16 on page 1, 2 on page 2)
    const largeContent = new Uint8Array(16 * 100);
    const mockFileLarge = {
      name: 'photo.png',
      type: 'image/png',
      size: largeContent.byteLength,
      arrayBuffer: async () => largeContent.buffer
    } as unknown as File;

    await sender.loadFile(mockFileLarge, 100);
    const largeInfoP0 = sender.getFrameInfo();
    expect(largeInfoP0.totalFrames).toBe(18);
    expect(largeInfoP0.totalPages).toBe(2);
    expect(largeInfoP0.activeSlotsCount).toBe(16);
    expect(largeInfoP0.emptySlotsCount).toBe(0); // Full page 1

    sender.nextFrame(); // Advance to page 1
    const largeInfoP1 = sender.getFrameInfo();
    expect(largeInfoP1.currentPage).toBe(1);
    expect(largeInfoP1.activeSlotsCount).toBe(2);
    expect(largeInfoP1.emptySlotsCount).toBe(14); // 16 - 2 = 14 empty slots on last page!

    // Test 2x2 mode
    sender.setGridMode('2x2');
    expect(sender.getPageSize()).toBe(4);
    expect(sender.getTotalPages()).toBe(5); // 18 / 4 = 4.5 -> 5 pages
    sender.seekPage(4); // Last page
    const p4Info = sender.getFrameInfo();
    expect(p4Info.activeSlotsCount).toBe(2);
    expect(p4Info.emptySlotsCount).toBe(2); // 4 - 2 = 2 empty slots!

    // Test 3x3 recommended sweet spot mode (9 modules)
    sender.setGridMode('3x3');
    expect(sender.getPageSize()).toBe(9);
    expect(sender.getTotalPages()).toBe(2); // 18 / 9 = 2 pages
    sender.seekPage(0);
    const p3Info = sender.getFrameInfo();
    expect(p3Info.activeSlotsCount).toBe(9);
    expect(p3Info.emptySlotsCount).toBe(0);

    // Test custom slot count (e.g. 20 modules)
    sender.setGridMode('custom');
    sender.setCustomSlotCount(20);
    expect(sender.getPageSize()).toBe(20);
    expect(sender.getTotalPages()).toBe(1); // 18 packets fit in 20 slots
    sender.seekPage(0);
    const customInfo = sender.getFrameInfo();
    expect(customInfo.activeSlotsCount).toBe(18);
    expect(customInfo.emptySlotsCount).toBe(2); // 20 - 18 = 2 empty slots
  });

  it('should support Device Connection Handshake (DEVICE_PAIR frame)', () => {
    const pairPacket = createPairingPacket('pair1234', 'Sender Phone', '3x3', 9);
    expect(pairPacket.type).toBe('DEVICE_PAIR');
    expect(pairPacket.transfer_id).toBe('pair1234');
    expect(pairPacket.grid_mode).toBe('3x3');
    expect(pairPacket.module_count).toBe(9);

    const serialized = serializePacket(pairPacket);
    const parsed = parsePacket(serialized);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe('DEVICE_PAIR');
    expect(parsed?.transfer_id).toBe('pair1234');

    // Feed pairing packet to assembler
    const assembler = new TransferAssembler();
    const result = assembler.addPacket(parsed!);
    expect(result.accepted).toBe(true);
    expect(result.packetType).toBe('DEVICE_PAIR');

    const progress = assembler.getProgress();
    expect(progress.isPaired).toBe(true);
    expect(progress.transferId).toBe('pair1234');
  });
});

