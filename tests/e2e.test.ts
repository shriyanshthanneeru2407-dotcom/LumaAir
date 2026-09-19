import { describe, it, expect } from 'vitest';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  createFilePackets,
  serializePacket,
  parsePacket,
  TransferAssembler
} from '../src/core/protocol';

describe('End-to-End Optical Transfer Simulation', () => {
  it('should encode chunks to QR images, decode with jsQR, and reassemble bit-for-bit file', async () => {
    // Create simulated file content
    const originalText = 'OpticalDrop Transmission Test: 1234567890 ABCDEFGHIJKLMNOPQRSTUVWXYZ! '.repeat(10);
    const originalBuffer = new TextEncoder().encode(originalText);
    const fileName = 'secret_document.txt';
    const mimeType = 'text/plain';

    // 1. Sender chunks file
    const packets = createFilePackets(originalBuffer, fileName, mimeType, 180);
    expect(packets.length).toBeGreaterThan(1);

    const assembler = new TransferAssembler();

    // 2. Transmit each frame: QR generation -> pixel scanning -> decoding -> assembly
    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i];
      const qrData = serializePacket(packet);

      // Create a canvas representation via qrcode raw modules or dataURL
      // QRCode.create generates the matrix of modules
      const qrObj = QRCode.create(qrData, { errorCorrectionLevel: 'M' });
      const size = qrObj.modules.size;
      const margin = 4;
      const fullSize = size + margin * 2;
      const scale = 4;
      const imgWidth = fullSize * scale;
      const imgHeight = fullSize * scale;

      // Build raw RGBA pixel buffer
      const rgbaBuffer = new Uint8ClampedArray(imgWidth * imgHeight * 4);
      // Fill white background
      rgbaBuffer.fill(255);

      // Fill black modules
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (qrObj.modules.get(r, c)) {
            // Draw scaled pixel block
            const startX = (c + margin) * scale;
            const startY = (r + margin) * scale;
            for (let dy = 0; dy < scale; dy++) {
              for (let dx = 0; dx < scale; dx++) {
                const px = ((startY + dy) * imgWidth + (startX + dx)) * 4;
                rgbaBuffer[px] = 0;     // R
                rgbaBuffer[px + 1] = 0; // G
                rgbaBuffer[px + 2] = 0; // B
                rgbaBuffer[px + 3] = 255; // A
              }
            }
          }
        }
      }

      // 3. Receiver decodes pixel buffer using jsQR
      const scanned = jsQR(rgbaBuffer, imgWidth, imgHeight);
      expect(scanned).not.toBeNull();
      expect(scanned?.data).toBeDefined();

      // 4. Parse optical packet
      const decodedPacket = parsePacket(scanned!.data);
      expect(decodedPacket).not.toBeNull();
      expect(decodedPacket?.seq).toBe(i);
      expect(decodedPacket?.name).toBe(fileName);

      // 5. Feed into assembler
      const addResult = assembler.addPacket(decodedPacket!);
      expect(addResult.accepted).toBe(true);
    }

    // 6. Verify completion & full reconstruction
    expect(assembler.isComplete()).toBe(true);
    const result = assembler.reconstruct();
    expect(result).not.toBeNull();
    expect(result?.fileName).toBe(fileName);
    expect(result?.mimeType).toBe(mimeType);
    expect(result?.fileBuffer).toEqual(originalBuffer);

    const recoveredText = new TextDecoder().decode(result!.fileBuffer);
    expect(recoveredText).toBe(originalText);
  });
});
