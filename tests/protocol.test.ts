import { describe, it, expect } from 'vitest';
import {
  packFile,
  unpackFile,
  verifyFile,
  packFrame,
  parseFrame,
  classifyFrame,
  streamIdentity,
  LTEncoder,
  LTDecoder,
  DEFAULT_FRAME_BYTES,
  getFileExtension,
} from '../src/core/protocol';
import { OpticalSender } from '../src/core/sender';
import { OpticalReceiver } from '../src/core/receiver';

describe('Decimen Optical Protocol (Wire v3) & Fountain Coding', () => {
  it('should correctly extract file extensions', () => {
    expect(getFileExtension('archive.tar.gz')).toBe('gz');
    expect(getFileExtension('photo.PNG')).toBe('png');
    expect(getFileExtension('document.pdf')).toBe('pdf');
    expect(getFileExtension('no_ext')).toBe('');
  });

  it('should roundtrip file container with packFile and unpackFile', async () => {
    const originalText = 'Decimen Optical Transfer air-gapped stream test content! '.repeat(50);
    const bytes = new TextEncoder().encode(originalText);

    const packed = await packFile('document.txt', 'text/plain', bytes);
    expect(packed.container.length).toBeGreaterThan(0);
    // Gzip should compress repeated text substantially
    expect(packed.compression).toBe('gzip');
    expect(packed.transmittedSize).toBeLessThan(bytes.length);

    const unpacked = await unpackFile(packed.container);
    expect(unpacked.name).toBe('document.txt');
    expect(unpacked.type).toBe('text/plain');
    expect(unpacked.bytes).toEqual(bytes);

    const valid = await verifyFile(unpacked);
    expect(valid).toBe(true);
  });

  it('should pack and parse 22-byte self-describing wire frames', () => {
    const block = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const header = {
      sessionId: 0x1234,
      seq: 42,
      k: 10,
      blockLen: 6,
      totalLen: 60,
      payloadFnv: 0x87654321,
      flags: 0
    };

    const wireBytes = packFrame(header, block);
    expect(wireBytes.length).toBe(22 + 6);
    expect(wireBytes[0]).toBe(0xd1);
    expect(wireBytes[1]).toBe(0xc3);
    expect(wireBytes[2]).toBe(3); // Wire v3

    const parsed = parseFrame(wireBytes);
    expect(parsed).not.toBeNull();
    expect(parsed!.header.sessionId).toBe(0x1234);
    expect(parsed!.header.seq).toBe(42);
    expect(parsed!.header.k).toBe(10);
    expect(parsed!.header.blockLen).toBe(6);
    expect(parsed!.block).toEqual(block);

    expect(classifyFrame(wireBytes).kind).toBe('ok');
    expect(streamIdentity(header)).toContain('4660:10:6:60');
  });

  it('should reject foreign or malformed frames', () => {
    const garbage = new Uint8Array([0x00, 0x11, 0x22, 0x33]);
    expect(classifyFrame(garbage).kind).toBe('foreign');
    expect(parseFrame(garbage)).toBeNull();
  });

  it('should encode and decode blocks using LT fountain coding with zero loss', () => {
    const payload = new Uint8Array(5000);
    for (let i = 0; i < 5000; i++) payload[i] = (i * 31) & 0xff;

    const blockLen = 500;
    const sessionId = 0x5678;
    const encoder = new LTEncoder(payload, blockLen, sessionId);
    expect(encoder.k).toBe(10);

    const decoder = new LTDecoder(encoder.k, blockLen, sessionId, payload.length);

    // Feed systematic sweep
    for (let s = 0; s < encoder.k; s++) {
      const block = encoder.encode(s);
      decoder.addFrame(s, block);
    }

    expect(decoder.isComplete).toBe(true);
    const assembled = decoder.assemble();
    expect(assembled).toEqual(payload);
  });

  it('should recover full payload even when 30% of frames are lost using fountain repair frames', () => {
    const payload = new Uint8Array(4000);
    for (let i = 0; i < 4000; i++) payload[i] = (i * 17) & 0xff;

    const blockLen = 400;
    const sessionId = 0x9abc;
    const encoder = new LTEncoder(payload, blockLen, sessionId);
    expect(encoder.k).toBe(10);

    const decoder = new LTDecoder(encoder.k, blockLen, sessionId, payload.length);

    // Drop 30% of systematic frames (drop seq 1, 4, 7)
    const dropped = new Set([1, 4, 7]);
    for (let s = 0; s < encoder.k; s++) {
      if (!dropped.has(s)) {
        decoder.addFrame(s, encoder.encode(s));
      }
    }
    expect(decoder.isComplete).toBe(false);

    // Fountain repair frames from seq >= k
    let repairSeq = encoder.k;
    while (!decoder.isComplete && repairSeq < 50) {
      decoder.addFrame(repairSeq, encoder.encode(repairSeq));
      repairSeq++;
    }

    expect(decoder.isComplete).toBe(true);
    const assembled = decoder.assemble();
    expect(assembled).toEqual(payload);
  });

  it('should configure OpticalSender with compact block counts and 60 FPS', async () => {
    const sender = new OpticalSender({ fps: 60 });
    expect(sender.getFps()).toBe(60);

    // Small 15 KB file
    const content = new Uint8Array(15 * 1024);
    for (let i = 0; i < content.length; i++) content[i] = i % 256;

    const mockFile = {
      name: 'photo.jpg',
      type: 'image/jpeg',
      size: content.byteLength,
      arrayBuffer: async () => content.buffer
    } as unknown as File;

    await sender.loadFile(mockFile, DEFAULT_FRAME_BYTES);

    const info = sender.getFrameInfo();
    // At 1465 bytes per frame, 15KB is only ~11 blocks instead of 632!
    expect(info.totalFrames).toBeLessThan(20);
    expect(sender.getState()).toBe('LOADED');

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
  });

  it('should process pairing beacon and fire onDevicePaired without breaking receiver scan state', async () => {
    let pairedSession: number | null = null;
    const receiver = new OpticalReceiver({
      onDevicePaired: (sid) => {
        pairedSession = sid;
      }
    });

    const beaconBlock = new Uint8Array(16);
    beaconBlock.set(new TextEncoder().encode('LumaAir'));
    const sessionId = 0xC104;
    const wireBytes = packFrame({
      sessionId,
      seq: 0,
      k: 1,
      blockLen: 16,
      totalLen: 16,
      payloadFnv: 0x12345678,
      flags: 0x80, // FLAG_PAIRING_BEACON
    }, beaconBlock);

    const handled = await receiver.handleRawBytes(wireBytes);
    expect(handled).toBe(true);
    expect(pairedSession).toBe(sessionId);
    // Receiver should NOT enter COMPLETE or ERROR state
    expect(receiver.getState()).not.toBe('ERROR');
    expect(receiver.getState()).not.toBe('COMPLETE');
    expect(receiver.getReconstructedFile()).toBeNull();
  });
});
