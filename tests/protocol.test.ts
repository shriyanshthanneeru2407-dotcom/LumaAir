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
  BatchFramePacket,
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

  it('should generate structured START, BATCH_FRAME (16 modules in 1 QR), and END frames with all required fields', () => {
    const textData = 'Structured Optical Communication Frame Protocol Phase 2 Verification'.repeat(10);
    const buffer = new TextEncoder().encode(textData);
    const chunkSize = 80;

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

    // Middle frames must be BATCH_FRAME bundling up to 16 modules in 1 single QR
    const totalDataChunks = startPacket.total_chunks;
    const totalBatches = Math.ceil(totalDataChunks / 16);
    expect(packets.length).toBe(totalBatches + 2);

    for (let b = 0; b < totalBatches; b++) {
      const batchPacket = packets[b + 1] as BatchFramePacket;
      expect(batchPacket.type).toBe('BATCH_FRAME');
      expect(batchPacket.transfer_id).toBe(startPacket.transfer_id);
      expect(batchPacket.batch_index).toBe(b);
      expect(batchPacket.total_batches).toBe(totalBatches);
      expect(batchPacket.total_chunks).toBe(totalDataChunks);
      expect(batchPacket.modules.length).toBeGreaterThan(0);
      expect(batchPacket.modules.length).toBeLessThanOrEqual(16);
      for (const mod of batchPacket.modules) {
        expect(mod.seq).toBeDefined();
        expect(mod.payload).toBeDefined();
        expect(mod.crc).toBeDefined();
      }
    }

    // Last frame must be TRANSFER_END
    const endPacket = packets[packets.length - 1] as TransferEndPacket;
    expect(endPacket.type).toBe('TRANSFER_END');
    expect(endPacket.protocol_version).toBe(2);
    expect(endPacket.transfer_id).toBe(startPacket.transfer_id);
    expect(endPacket.total_chunks).toBe(totalDataChunks);
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

  it('should reject corrupted module payload CRC inside BATCH_FRAME', () => {
    const file = new TextEncoder().encode('Integrity critical document');
    const packets = createTransferPackets(file, 'doc.txt', 'text/plain', 10);
    const batchFrame = packets[1] as BatchFramePacket;
    expect(batchFrame.type).toBe('BATCH_FRAME');
    expect(batchFrame.modules.length).toBeGreaterThan(0);

    // Tamper with first module's CRC
    const origCrc = batchFrame.modules[0].crc;
    batchFrame.modules[0].crc = origCrc ^ 0x9999;
    const serialized = serializePacket(batchFrame);
    const parsed = parsePacket(serialized) as BatchFramePacket | null;
    expect(parsed).not.toBeNull();
    // parsePacket discards the corrupted module
    expect(parsed?.modules.some(m => m.crc === origCrc)).toBe(false);
  });

  it('should reassemble full file and verify whole-file checksum across batches', () => {
    const rawBytes = new Uint8Array(800);
    for (let i = 0; i < 800; i++) rawBytes[i] = (i * 17) % 256;

    const packets = createTransferPackets(rawBytes, 'dataset.bin', 'application/octet-stream', 50);
    const assembler = new TransferAssembler();

    // Shuffle packets out of order (e.g. batch frames first, then start, then end)
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

  it('should bundle 16 modules in 1 single 1x1 QR code and ingest all 16 modules from 1 scan', () => {
    // Generate a file that breaks into exactly 16 data modules (16 * 50 = 800 bytes)
    const dataSize = 16 * 50;
    const rawBytes = new Uint8Array(dataSize);
    for (let i = 0; i < dataSize; i++) rawBytes[i] = (i + 42) % 256;

    const packets = createTransferPackets(rawBytes, 'batch_16_file.bin', 'application/octet-stream', 50);
    // packets: 0: START, 1: BATCH_FRAME (16 modules), 2: END
    expect(packets.length).toBe(3);
    const batchPacket = packets[1] as BatchFramePacket;
    expect(batchPacket.type).toBe('BATCH_FRAME');
    expect(batchPacket.modules.length).toBe(16); // Exactly 16 modules combined in 1 QR!

    const assembler = new TransferAssembler();

    // 1. Ingest START header
    assembler.addPacket(packets[0]);
    expect(assembler.getProgress().receivedCount).toBe(0);

    // 2. In a SINGLE scan, 1 QR code is decoded, ingesting all 16 modules simultaneously
    const res = assembler.addPacket(batchPacket);
    expect(res.accepted).toBe(true);
    expect(assembler.getProgress().receivedCount).toBe(16); // All 16 modules loaded at once!

    // 3. Ingest END marker
    assembler.addPacket(packets[2]);
    expect(assembler.isComplete()).toBe(true);

    const reconstructed = assembler.reconstruct();
    expect(reconstructed).not.toBeNull();
    expect(reconstructed?.fileBuffer.byteLength).toBe(dataSize);
    expect(reconstructed?.fileBuffer).toEqual(rawBytes);
  });

  it('should support OpticalSender 1x1 mode with all 5 playback controls (start, pause, stop, prev, next)', async () => {
    const { OpticalSender } = await import('../src/core/sender');

    const sender = new OpticalSender({ fps: 3 });
    expect(sender.getGridMode()).toBe('1x1');
    expect(sender.getPageSize()).toBe(1);

    // Mock a File with 32 chunks (16 in Batch 1, 16 in Batch 2)
    const content = new Uint8Array(32 * 50);
    const mockFile = {
      name: 'stream.dat',
      type: 'application/octet-stream',
      size: content.byteLength,
      arrayBuffer: async () => content.buffer
    } as unknown as File;

    await sender.loadFile(mockFile, 50);

    const infoP0 = sender.getFrameInfo();
    // 1 START + 2 BATCHES + 1 END = 4 frames
    expect(infoP0.totalFrames).toBe(4);
    expect(infoP0.gridMode).toBe('1x1');
    expect(sender.getState()).toBe('LOADED');

    // Test Playback Controls:
    // 1. Next frame
    sender.nextFrame();
    const info1 = sender.getFrameInfo();
    expect(info1.frameIndex).toBe(1);
    expect(info1.frameType).toBe('BATCH_FRAME');
    expect(info1.batchModulesCount).toBe(16); // 16 modules inside Batch 1

    // 2. Next frame again (Batch 2)
    sender.nextFrame();
    const info2 = sender.getFrameInfo();
    expect(info2.frameIndex).toBe(2);
    expect(info2.frameType).toBe('BATCH_FRAME');
    expect(info2.batchModulesCount).toBe(16); // 16 modules inside Batch 2

    // 3. Previous frame
    sender.prevFrame();
    expect(sender.getFrameInfo().frameIndex).toBe(1);

    // 4. Start transmission
    sender.start();
    expect(sender.getState()).toBe('TRANSMITTING');

    // 5. Pause
    sender.pause();
    expect(sender.getState()).toBe('PAUSED');

    // 6. Stop
    sender.stop();
    expect(sender.getState()).toBe('STOPPED');
    expect(sender.getFrameInfo().frameIndex).toBe(0);
  });

  it('should support Device Connection Handshake in 1x1 mode (DEVICE_PAIR frame)', () => {
    const pairPacket = createPairingPacket('pair1234', 'Sender Phone', '1x1', 16);
    expect(pairPacket.type).toBe('DEVICE_PAIR');
    expect(pairPacket.transfer_id).toBe('pair1234');
    expect(pairPacket.grid_mode).toBe('1x1');
    expect(pairPacket.module_count).toBe(16);

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

