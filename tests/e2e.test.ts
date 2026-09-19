import { describe, it, expect } from 'vitest';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  createTransferPackets,
  serializePacket,
  parsePacket,
  TransferAssembler
} from '../src/core/protocol';

describe('Phase 2 End-to-End Structured Optical Transfer Simulation', () => {
  it('should encode START, DATA, and END frames to QR images, decode with jsQR, and reassemble verified file', async () => {
    const originalText = 'Luma Phase 2 Optical Transfer: START -> DATA -> END with CRC32 integrity! '.repeat(8);
    const originalBuffer = new TextEncoder().encode(originalText);
    const fileName = 'presentation.key';
    const mimeType = 'application/octet-stream';

    // 1. Sender creates structured packets
    const packets = createTransferPackets(originalBuffer, fileName, mimeType, 60, 16);
    expect(packets[0].type).toBe('TRANSFER_START');
    expect(packets[1].type).toBe('BATCH_FRAME');
    expect((packets[1] as any).modules.length).toBeGreaterThan(1);
    expect(packets[packets.length - 1].type).toBe('TRANSFER_END');

    const assembler = new TransferAssembler();

    // 2. Optical transmission loop: QR rendering -> pixel reading -> scanning -> assembly
    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i];
      const qrData = serializePacket(packet);

      const qrObj = QRCode.create(qrData, { errorCorrectionLevel: 'M' });
      const size = qrObj.modules.size;
      const margin = 4;
      const fullSize = size + margin * 2;
      const scale = 4;
      const imgWidth = fullSize * scale;
      const imgHeight = fullSize * scale;

      const rgbaBuffer = new Uint8ClampedArray(imgWidth * imgHeight * 4);
      rgbaBuffer.fill(255); // White background

      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (qrObj.modules.get(r, c)) {
            const startX = (c + margin) * scale;
            const startY = (r + margin) * scale;
            for (let dy = 0; dy < scale; dy++) {
              for (let dx = 0; dx < scale; dx++) {
                const px = ((startY + dy) * imgWidth + (startX + dx)) * 4;
                rgbaBuffer[px] = 0;
                rgbaBuffer[px + 1] = 0;
                rgbaBuffer[px + 2] = 0;
                rgbaBuffer[px + 3] = 255;
              }
            }
          }
        }
      }

      // Receiver decodes pixel buffer
      const scanned = jsQR(rgbaBuffer, imgWidth, imgHeight);
      expect(scanned).not.toBeNull();
      expect(scanned?.data).toBeDefined();

      const decodedPacket = parsePacket(scanned!.data);
      expect(decodedPacket).not.toBeNull();
      expect(decodedPacket?.type).toBe(packet.type);
      expect(decodedPacket?.transfer_id).toBe(packet.transfer_id);

      const addResult = assembler.addPacket(decodedPacket!);
      expect(addResult.accepted).toBe(true);
    }

    // 3. Verification & reconstruction
    expect(assembler.isComplete()).toBe(true);
    const result = assembler.reconstruct();
    expect(result).not.toBeNull();
    expect(result?.fileName).toBe(fileName);
    expect(result?.fileExt).toBe('key');
    expect(result?.fileBuffer).toEqual(originalBuffer);

    const recoveredText = new TextDecoder().decode(result!.fileBuffer);
    expect(recoveredText).toBe(originalText);
  });
});
