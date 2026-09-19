import { describe, it, expect } from 'vitest';
import {
  createFilePackets,
  serializePacket,
  parsePacket,
  TransferAssembler,
  crc32,
  bytesToBase64,
  base64ToBytes
} from '../src/core/protocol';

describe('Protocol & Chunking Engine', () => {
  it('should roundtrip binary data to base64 correctly', () => {
    const original = new Uint8Array([0, 1, 2, 254, 255, 128, 64, 32, 16, 8, 4, 2, 1]);
    const b64 = bytesToBase64(original);
    const decoded = base64ToBytes(b64);
    expect(decoded).toEqual(original);
  });

  it('should compute consistent CRC32', () => {
    const data1 = new TextEncoder().encode('Hello, Optical World!');
    const data2 = new TextEncoder().encode('Hello, Optical World!');
    const data3 = new TextEncoder().encode('Different string');
    
    expect(crc32(data1)).toBe(crc32(data2));
    expect(crc32(data1)).not.toBe(crc32(data3));
  });

  it('should split file into correct number of chunks and serialize', () => {
    const sampleText = 'The quick brown fox jumps over the lazy dog. '.repeat(20); // ~900 bytes
    const sampleBuffer = new TextEncoder().encode(sampleText);
    const chunkSize = 200;

    const packets = createFilePackets(sampleBuffer, 'fox.txt', 'text/plain', chunkSize);
    expect(packets.length).toBe(Math.ceil(sampleBuffer.length / chunkSize));
    expect(packets[0].total).toBe(packets.length);
    expect(packets[0].seq).toBe(0);
    expect(packets[packets.length - 1].seq).toBe(packets.length - 1);

    // Verify serialize and parse
    const serialized0 = serializePacket(packets[0]);
    const parsed0 = parsePacket(serialized0);
    expect(parsed0).not.toBeNull();
    expect(parsed0?.seq).toBe(0);
    expect(parsed0?.name).toBe('fox.txt');
    expect(parsed0?.size).toBe(sampleBuffer.length);
  });

  it('should reject packets with corrupted CRC', () => {
    const sampleBuffer = new TextEncoder().encode('Sensitive data packet');
    const packets = createFilePackets(sampleBuffer, 'data.bin', 'application/octet-stream', 100);
    const packet = packets[0];

    // Corrupt CRC
    packet.crc = packet.crc ^ 0x12345678;
    const serialized = serializePacket(packet);
    const parsed = parsePacket(serialized);
    expect(parsed).toBeNull();
  });

  it('should assemble out-of-order packets and reconstruct identical file', async () => {
    // Generate 1500 bytes of pseudo-random binary data
    const originalBytes = new Uint8Array(1500);
    for (let i = 0; i < 1500; i++) {
      originalBytes[i] = (i * 37 + 13) % 256;
    }

    const packets = createFilePackets(originalBytes, 'random_data.bin', 'application/octet-stream', 220);
    expect(packets.length).toBe(7);

    // Shuffle packet arrival order (e.g. [3, 0, 5, 1, 6, 2, 4])
    const shuffled = [...packets].sort(() => Math.random() - 0.5);

    const assembler = new TransferAssembler();
    for (const p of shuffled) {
      const serialized = serializePacket(p);
      const parsed = parsePacket(serialized);
      expect(parsed).not.toBeNull();
      if (parsed) {
        assembler.addPacket(parsed);
      }
    }

    expect(assembler.isComplete()).toBe(true);
    const reconstructed = assembler.reconstruct();
    expect(reconstructed).not.toBeNull();
    expect(reconstructed?.fileName).toBe('random_data.bin');
    expect(reconstructed?.fileBuffer).toEqual(originalBytes);

    const bufferText = await reconstructed?.blob.arrayBuffer();
    expect(new Uint8Array(bufferText!)).toEqual(originalBytes);
  });
});
