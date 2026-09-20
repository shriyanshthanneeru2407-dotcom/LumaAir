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

import { OpticalReceiver, ReconstructedFile } from '../src/core/receiver';
import { readBarcodesFromImageData } from 'zxing-wasm/reader';

describe('Decimen WASM QR & OpticalReceiver End-to-End', () => {
  it('should decode 1465-byte QR code via zxing-wasm and reconstruct file via OpticalReceiver', async () => {
    const rawContent = 'High-speed Decimen Optical Air-Gap Receiver Test Content! '.repeat(80);
    const contentBytes = new TextEncoder().encode(rawContent);

    const packed = await packFile('sample_test.txt', 'text/plain', contentBytes);
    const blockLen = 1465 - 22; // 1443
    const sessionId = 0x9876;
    const encoder = new LTEncoder(packed.container, blockLen, sessionId);
    const payloadFnv = fnv1a(packed.container);

    let completedFile: ReconstructedFile | null = null;
    const receiver = new OpticalReceiver({
      onFileComplete: (f) => {
        completedFile = f;
      }
    });

    for (let s = 0; s < encoder.k; s++) {
      const block = encoder.encode(s);
      const wire = packFrame({
        sessionId,
        seq: s,
        k: encoder.k,
        blockLen,
        totalLen: packed.container.length,
        payloadFnv,
        flags: 0,
      }, block);

      // Render QR
      const qr = QRCode.create([{ data: wire, mode: 'byte' } as unknown as QRCode.QRCodeSegment], {
        errorCorrectionLevel: 'L',
        maskPattern: 4,
      });

      const mod = qr.modules.size;
      const margin = 4;
      const dim = (mod + 2 * margin) * 3;
      const rgba = new Uint8ClampedArray(dim * dim * 4);
      rgba.fill(255);

      for (let r = 0; r < mod; r++) {
        for (let c = 0; c < mod; c++) {
          if (qr.modules.get(r, c)) {
            for (let dy = 0; dy < 3; dy++) {
              for (let dx = 0; dx < 3; dx++) {
                const px = ((r + margin) * 3 + dy) * dim + ((c + margin) * 3 + dx);
                rgba[px * 4] = 0;
                rgba[px * 4 + 1] = 0;
                rgba[px * 4 + 2] = 0;
                rgba[px * 4 + 3] = 255;
              }
            }
          }
        }
      }

      // Decode with zxing-wasm
      const results = await readBarcodesFromImageData({
        data: rgba,
        width: dim,
        height: dim,
        colorSpace: 'srgb' as PredefinedColorSpace,
      } as ImageData, {
        formats: ['QRCode'],
        tryHarder: false,
      });

      expect(results.length).toBeGreaterThan(0);
      const decodedBytes = results[0].bytes;
      expect(decodedBytes.length).toBe(wire.length);

      await receiver.handleRawBytes(decodedBytes);
    }

    expect(completedFile).not.toBeNull();
    expect(completedFile!.fileName).toBe('sample_test.txt');
    expect(completedFile!.fileSize).toBe(contentBytes.length);
  });
});
