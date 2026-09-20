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

describe('Decimen Optical Protocol — Single Streaming QR Stream', () => {
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

  it('should generate structured START, DATA_FRAME, and END packets for single QR stream', () => {
    const textData = 'Decimen Optical Communication Air-Gap Protocol Verification'.repeat(10);
    const buffer = new TextEncoder().encode(textData);
    const chunkSize = 250;

    const packets = createTransferPackets(buffer, 'report.pdf', 'application/pdf', chunkSize);

    // First packet must be TRANSFER_START
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

    // Middle packets must be DATA_FRAME (single stream)
    const totalChunks = startPacket.total_chunks;
    expect(packets.length).toBe(totalChunks + 2);

    for (let i = 0; i < totalChunks; i++) {
      const dataPacket = packets[i + 1] as DataFramePacket;
      expect(dataPacket.type).toBe('DATA_FRAME');
      expect(dataPacket.transfer_id).toBe(startPacket.transfer_id);
      expect(dataPacket.seq).toBe(i);
      expect(dataPacket.total_chunks).toBe(totalChunks);
      expect(dataPacket.payload).toBeDefined();
      expect(dataPacket.crc).toBeDefined();
    }

    // Last packet must be TRANSFER_END
    const endPacket = packets[packets.length - 1] as TransferEndPacket;
    expect(endPacket.type).toBe('TRANSFER_END');
    expect(endPacket.protocol_version).toBe(2);
    expect(endPacket.transfer_id).toBe(startPacket.transfer_id);
    expect(endPacket.total_chunks).toBe(totalChunks);
    expect(endPacket.checksum).toBe(startPacket.file_checksum);
  });

  it('should serialize and deserialize all frame types correctly', () => {
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

    // 2. Foreign packet rejected
    const resB = assembler.addPacket(packetsB[1]);
    expect(resB.accepted).toBe(false);
    expect(resB.rejectedReason).toContain('different transfer');
    expect(assembler.getProgress().rejectedCount).toBe(1);

    // 3. Transfer A continues
    const resA2 = assembler.addPacket(packetsA[1]);
    expect(resA2.accepted).toBe(true);
  });

  it('should reject DATA_FRAME with corrupted payload CRC', () => {
    const file = new TextEncoder().encode('Integrity critical document');
    const packets = createTransferPackets(file, 'doc.txt', 'text/plain', 10);
    const dataPacket = packets[1] as DataFramePacket;
    expect(dataPacket.type).toBe('DATA_FRAME');

    const serialized = serializePacket(dataPacket);
    const parsed = JSON.parse(serialized.slice('LUMA2:'.length));
    parsed.crc = parsed.crc ^ 0x9999; // Corrupt CRC
    const tamperedStr = 'LUMA2:' + JSON.stringify(parsed);
    const result = parsePacket(tamperedStr);
    expect(result).toBeNull();
  });

  it('should reassemble full file and verify whole-file checksum from shuffled frames', () => {
    const rawBytes = new Uint8Array(800);
    for (let i = 0; i < 800; i++) rawBytes[i] = (i * 17) % 256;

    const packets = createTransferPackets(rawBytes, 'dataset.bin', 'application/octet-stream', 200);
    const assembler = new TransferAssembler();

    const shuffled = [...packets].sort(() => Math.random() - 0.5);
    for (const p of shuffled) {
      assembler.addPacket(p);
    }

    expect(assembler.isComplete()).toBe(true);
    const reconstructed = assembler.reconstruct();
    expect(reconstructed).not.toBeNull();
    expect(reconstructed?.fileName).toBe('dataset.bin');
    expect(reconstructed?.fileBuffer).toEqual(rawBytes);
    expect(reconstructed?.checksum).toBe(crc32(rawBytes));
  });

  it('should support single-QR OpticalSender with all 5 playback controls (start, pause, stop, prev, next)', async () => {
    const { OpticalSender } = await import('../src/core/sender');

    const sender = new OpticalSender({ fps: 6 });
    expect(sender.getGridMode()).toBe('1x1');
    expect(sender.getPageSize()).toBe(1);

    const content = new Uint8Array(300);
    for (let i = 0; i < 300; i++) content[i] = i % 256;
    const mockFile = {
      name: 'stream.dat',
      type: 'application/octet-stream',
      size: content.byteLength,
      arrayBuffer: async () => content.buffer
    } as unknown as File;

    await sender.loadFile(mockFile, 150);

    const info = sender.getFrameInfo();
    // 1 START + 2 DATA + 1 END = 4 frames
    expect(info.totalFrames).toBe(4);
    expect(sender.getState()).toBe('LOADED');

    // Controls
    sender.nextFrame();
    expect(sender.getFrameInfo().frameIndex).toBe(1);

    sender.prevFrame();
    expect(sender.getFrameInfo().frameIndex).toBe(0);

    sender.start();
    expect(sender.getState()).toBe('TRANSMITTING');

    sender.pause();
    expect(sender.getState()).toBe('PAUSED');

    sender.stop();
    expect(sender.getState()).toBe('STOPPED');

    // Test 60 FPS configuration
    const sender60 = new OpticalSender();
    expect(sender60.getFps()).toBe(60);
    sender60.setFps(60);
    expect(sender60.getFps()).toBe(60);
    sender60.setFps(120); // Clamped to 60
    expect(sender60.getFps()).toBe(60);
    sender60.setFps(0); // Clamped to 1
    expect(sender60.getFps()).toBe(1);
  });

  it('should support Device Connection Handshake DEVICE_PAIR frame', () => {
    const pairPacket = createPairingPacket('pair1234', 'Sender Phone', '1x1', 1);
    expect(pairPacket.type).toBe('DEVICE_PAIR');
    expect(pairPacket.transfer_id).toBe('pair1234');
    expect(pairPacket.grid_mode).toBe('1x1');
    expect(pairPacket.module_count).toBe(1);

    const serialized = serializePacket(pairPacket);
    const parsed = parsePacket(serialized);
    expect(parsed).not.toBeNull();

    const assembler = new TransferAssembler();
    const result = assembler.addPacket(parsed!);
    expect(result.accepted).toBe(true);
    expect(assembler.getProgress().isPaired).toBe(true);
  });
});
