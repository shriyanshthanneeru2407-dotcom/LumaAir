import { describe, it, expect } from 'vitest';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  packFile,
  unpackFile,
  verifyFile,
  packFrame,
  parseFrame,
  LTEncoder,
  LTDecoder,
  fnv1a,
} from '../src/core/protocol';

describe('Decimen Optical Transfer E2E Pipeline', () => {
  it('should encode file with Decimen fountain code into QR images, scan with jsQR, and verify SHA-256', async () => {
    const textData = 'LumaAir + Decimen Optical Transfer Engine Benchmark! '.repeat(20);
    const bytes = new TextEncoder().encode(textData);

    // 1. Pack file
    const packed = await packFile('report.txt', 'text/plain', bytes);
    const blockLen = 200;
    const sessionId = 0x4321;
    const encoder = new LTEncoder(packed.container, blockLen, sessionId);
    const payloadFnv = fnv1a(packed.container);

    const decoder = new LTDecoder(encoder.k, blockLen, sessionId, packed.container.length);

    // 2. Optical loop: encode frame -> QR byte mode -> pixel buffer -> jsQR -> decode
    for (let s = 0; s < encoder.k; s++) {
      const block = encoder.encode(s);
      const wireBytes = packFrame({
        sessionId,
        seq: s,
        k: encoder.k,
        blockLen,
        totalLen: packed.container.length,
        payloadFnv,
        flags: 0,
      }, block);

      // Render QR
      const qr = QRCode.create([{ data: wireBytes, mode: 'byte' } as unknown as QRCode.QRCodeSegment], {
        errorCorrectionLevel: 'L',
        maskPattern: 4,
      });

      const modCount = qr.modules.size;
      const margin = 4;
      const size = modCount + 2 * margin;
      const rgba = new Uint8ClampedArray(size * size * 4);
      rgba.fill(255);

      for (let y = 0; y < modCount; y++) {
        for (let x = 0; x < modCount; x++) {
          if (qr.modules.data[y * modCount + x]) {
            const idx = ((y + margin) * size + (x + margin)) * 4;
            rgba[idx] = 0;
            rgba[idx + 1] = 0;
            rgba[idx + 2] = 0;
          }
        }
      }

      // Scan with jsQR
      const decoded = jsQR(rgba, size, size);
      expect(decoded).not.toBeNull();
      expect(decoded!.binaryData.length).toBe(wireBytes.length);

      const parsed = parseFrame(Uint8Array.from(decoded!.binaryData));
      expect(parsed).not.toBeNull();
      decoder.addFrame(parsed!.header.seq, parsed!.block);
    }

    expect(decoder.isComplete).toBe(true);
    const recoveredContainer = decoder.assemble()!;
    expect(recoveredContainer).toEqual(packed.container);

    const restoredFile = await unpackFile(recoveredContainer);
    expect(restoredFile.name).toBe('report.txt');
    expect(restoredFile.bytes).toEqual(bytes);

    const valid = await verifyFile(restoredFile);
    expect(valid).toBe(true);
  });
});
