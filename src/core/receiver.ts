import jsQR from 'jsqr';
import {
  parsePacket,
  TransferAssembler,
  TransferProgress,
  ProtocolPacket,
  DevicePairPacket,
  AddPacketResult
} from './protocol';

export type ReceiverState = 'IDLE' | 'STARTING' | 'SCANNING' | 'RECEIVING' | 'COMPLETE' | 'ERROR';

export interface ReconstructedFile {
  fileName: string;
  fileExt: string;
  fileSize: number;
  mimeType: string;
  transferId: string;
  checksum: number;
  blob: Blob;
  downloadUrl: string;
  textPreview?: string;
  isImage?: boolean;
}

export interface ReceiverCallbacks {
  onStateChange?: (state: ReceiverState, detail?: string) => void;
  onProgress?: (progress: TransferProgress, latestPacket: ProtocolPacket | null) => void;
  onDevicePaired?: (packet: DevicePairPacket) => void;
  onFileComplete?: (file: ReconstructedFile) => void;
  onFrameRejected?: (packet: ProtocolPacket, reason: string) => void;
  onBatchScanned?: (acceptedInFrame: number, totalFoundInFrame: number) => void;
  onError?: (err: Error) => void;
}

export class OpticalReceiver {
  private state: ReceiverState = 'IDLE';
  private videoElement: HTMLVideoElement | null = null;
  private mediaStream: MediaStream | null = null;
  private scanCanvas: HTMLCanvasElement;
  private scanCtx: CanvasRenderingContext2D | null;
  private animFrameId: number | null = null;
  private scanIntervalId: number | null = null;
  private assembler = new TransferAssembler();
  private callbacks: ReceiverCallbacks = {};
  private reconstructedFile: ReconstructedFile | null = null;
  private barcodeDetector: any = null;
  private isDetecting = false;
  private lastScannedKey: string = '';

  constructor(callbacks?: ReceiverCallbacks) {
    if (callbacks) this.callbacks = callbacks;
    this.scanCanvas = document.createElement('canvas');
    this.scanCtx = this.scanCanvas.getContext('2d', { willReadFrequently: true });

    // Initialize native BarcodeDetector if available (GPU-accelerated, finds all QRs in one frame)
    if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
      try {
        this.barcodeDetector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
      } catch (e) {
        console.warn('[OpticalReceiver] BarcodeDetector init failed, falling back to jsQR', e);
        this.barcodeDetector = null;
      }
    }
  }

  public async getAvailableCameras(): Promise<MediaDeviceInfo[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  public async startCamera(
    videoElement: HTMLVideoElement,
    deviceId?: string,
    facingMode: 'environment' | 'user' = 'environment'
  ): Promise<void> {
    this.stop();
    this.videoElement = videoElement;
    this.setState('STARTING');

    const constraints: MediaStreamConstraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } }
    };

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.videoElement.srcObject = this.mediaStream;
      await this.videoElement.play();
      this.setState('SCANNING');
      this.startVideoScanLoop();
    } catch (err: any) {
      this.setState('ERROR', err.message || 'Camera access denied');
      if (this.callbacks.onError) this.callbacks.onError(err);
      throw err;
    }
  }

  /**
   * Scan directly from a source canvas (for loopback sandbox)
   */
  public startCanvasScan(sourceCanvas: HTMLCanvasElement) {
    this.stop();
    this.setState('SCANNING');

    const scanStep = async () => {
      const curState = this.state as ReceiverState;
      if (curState === 'COMPLETE' || curState === 'IDLE') return;

      // Try BarcodeDetector first (native, can detect all QRs in grid at once)
      if (this.barcodeDetector) {
        try {
          const barcodes = await this.barcodeDetector.detect(sourceCanvas);
          if (barcodes && barcodes.length > 0) {
            let acceptedCount = 0;
            for (const barcode of barcodes) {
              if (barcode.rawValue) {
                const accepted = await this.handleRawQrData(barcode.rawValue);
                if (accepted) acceptedCount++;
              }
            }
            if (this.callbacks.onBatchScanned) {
              this.callbacks.onBatchScanned(acceptedCount, barcodes.length);
            }
          }
        } catch {}
      }

      // jsQR fallback
      if (sourceCanvas.width > 0 && sourceCanvas.height > 0) {
        const srcCtx = sourceCanvas.getContext('2d');
        if (srcCtx) {
          const imgData = srcCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
          await this.processImageData(imgData);
        }
      }

      const postState = this.state as ReceiverState;
      if (postState !== 'COMPLETE' && postState !== 'IDLE') {
        this.scanIntervalId = window.setTimeout(scanStep, 60);
      }
    };

    scanStep();
  }

  public stop() {
    if (this.scanIntervalId !== null) {
      clearTimeout(this.scanIntervalId);
      this.scanIntervalId = null;
    }
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    if (this.videoElement) {
      this.videoElement.srcObject = null;
    }
    this.isDetecting = false;
    this.setState('IDLE');
  }

  public resetTransfer() {
    this.assembler.reset();
    if (this.reconstructedFile?.downloadUrl) {
      URL.revokeObjectURL(this.reconstructedFile.downloadUrl);
    }
    this.reconstructedFile = null;
    this.lastScannedKey = '';
    if (this.state === 'COMPLETE') {
      this.setState('SCANNING');
      if (this.videoElement && this.mediaStream) {
        this.startVideoScanLoop();
      }
    }
    this.notifyProgress(null);
  }

  public getReconstructedFile(): ReconstructedFile | null {
    return this.reconstructedFile;
  }

  public downloadFile() {
    if (!this.reconstructedFile) return;
    const a = document.createElement('a');
    a.href = this.reconstructedFile.downloadUrl;
    a.download = this.reconstructedFile.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  private startVideoScanLoop() {
    const loop = async () => {
      const curState = this.state as ReceiverState;
      if (!this.videoElement || curState === 'COMPLETE' || curState === 'IDLE' || curState === 'ERROR') {
        return;
      }

      if (this.videoElement.readyState === this.videoElement.HAVE_ENOUGH_DATA && !this.isDetecting) {
        this.isDetecting = true;
        try {
          await this.scanVideoFrame();
        } catch (e) {
          console.error('[OpticalReceiver] Scan error:', e);
        } finally {
          this.isDetecting = false;
        }
      }

      const postState = this.state as ReceiverState;
      if (postState !== 'COMPLETE' && postState !== 'IDLE' && postState !== 'ERROR') {
        this.animFrameId = requestAnimationFrame(loop);
      }
    };

    this.animFrameId = requestAnimationFrame(loop);
  }

  private async scanVideoFrame() {
    if (!this.videoElement || !this.scanCtx) return;

    const vw = this.videoElement.videoWidth;
    const vh = this.videoElement.videoHeight;
    if (vw === 0 || vh === 0) return;

    // Primary: BarcodeDetector (native, GPU-accelerated — detects all QRs in one call)
    if (this.barcodeDetector) {
      try {
        const barcodes = await this.barcodeDetector.detect(this.videoElement);
        if (barcodes && barcodes.length > 0) {
          let acceptedCount = 0;
          for (const barcode of barcodes) {
            if (barcode.rawValue) {
              const accepted = await this.handleRawQrData(barcode.rawValue);
              if (accepted) acceptedCount++;
            }
          }
          if (this.callbacks.onBatchScanned) {
            this.callbacks.onBatchScanned(acceptedCount, barcodes.length);
          }
          return;
        }
      } catch {
        // Fall through to jsQR
      }
    }

    // jsQR fallback: draw full frame at reduced resolution then scan quadrants
    const maxDim = 1280;
    let targetW = vw;
    let targetH = vh;
    if (targetW > maxDim || targetH > maxDim) {
      const scale = maxDim / Math.max(targetW, targetH);
      targetW = Math.floor(targetW * scale);
      targetH = Math.floor(targetH * scale);
    }

    if (this.scanCanvas.width !== targetW || this.scanCanvas.height !== targetH) {
      this.scanCanvas.width = targetW;
      this.scanCanvas.height = targetH;
    }

    this.scanCtx.drawImage(this.videoElement, 0, 0, targetW, targetH);
    const imgData = this.scanCtx.getImageData(0, 0, targetW, targetH);
    await this.processImageData(imgData);
  }

  /**
   * Multi-QR jsQR scan: tries full frame first, then four quadrants simultaneously.
   * This handles 2×2, 3×3, and 4×4 grid layouts.
   */
  private async processImageData(imgData: ImageData) {
    const w = imgData.width;
    const h = imgData.height;
    let totalDetected = 0;

    // 1. Full-frame scan (catches any QR that fits fully in frame)
    const fullCode = jsQR(imgData.data, w, h, { inversionAttempts: 'attemptBoth' });
    if (fullCode?.data) {
      const acc = await this.handleRawQrData(fullCode.data);
      if (acc) totalDetected++;
    }

    // 2. Quadrant scans in parallel — covers 4 sectors for 2×2 and larger grids
    if (this.scanCtx && w >= 200 && h >= 200) {
      const halfW = Math.floor(w / 2);
      const halfH = Math.floor(h / 2);
      const quadrants = [
        { x: 0, y: 0, qw: halfW, qh: halfH },
        { x: halfW, y: 0, qw: w - halfW, qh: halfH },
        { x: 0, y: halfH, qw: halfW, qh: h - halfH },
        { x: halfW, y: halfH, qw: w - halfW, qh: h - halfH },
      ];

      const quadResults = await Promise.all(
        quadrants.map(async ({ x, y, qw, qh }) => {
          try {
            const quadImg = this.scanCtx!.getImageData(x, y, qw, qh);
            const code = jsQR(quadImg.data, qw, qh, { inversionAttempts: 'attemptBoth' });
            if (code?.data) {
              return this.handleRawQrData(code.data);
            }
          } catch { /* ignore */ }
          return false;
        })
      );
      for (const acc of quadResults) {
        if (acc) totalDetected++;
      }

      // 3. For 3×3 and 4×4 grids: also scan thirds of the frame width
      // This catches QRs in middle columns that the quadrant splits miss
      if (w >= 600 && h >= 400) {
        const thirdW = Math.floor(w / 3);
        const thirds = [
          { x: 0, y: 0, qw: thirdW, qh: h },
          { x: thirdW, y: 0, qw: thirdW, qh: h },
          { x: thirdW * 2, y: 0, qw: w - thirdW * 2, qh: h },
        ];
        const thirdResults = await Promise.all(
          thirds.map(async ({ x, y, qw, qh }) => {
            try {
              const strip = this.scanCtx!.getImageData(x, y, qw, qh);
              const code = jsQR(strip.data, qw, qh, { inversionAttempts: 'attemptBoth' });
              if (code?.data) return this.handleRawQrData(code.data);
            } catch {}
            return false;
          })
        );
        for (const acc of thirdResults) {
          if (acc) totalDetected++;
        }
      }
    }

    if (totalDetected > 1 && this.callbacks.onBatchScanned) {
      this.callbacks.onBatchScanned(totalDetected, totalDetected);
    }
  }

  private async handleRawQrData(rawData: string): Promise<boolean> {
    const packet = parsePacket(rawData);
    if (!packet) return false;

    const seqKey = (packet as any).seq ?? (packet as any).batch_index ?? 0;
    const frameKey = `${packet.transfer_id}_${packet.type}_${seqKey}`;
    const isConsecutiveDuplicate = this.lastScannedKey === frameKey;
    this.lastScannedKey = frameKey;

    const result: AddPacketResult = this.assembler.addPacket(packet);

    if (!result.accepted) {
      if (this.callbacks.onFrameRejected && result.rejectedReason) {
        this.callbacks.onFrameRejected(packet, result.rejectedReason);
      }
      this.notifyProgress(packet);
      return false;
    }

    if (packet.type === 'DEVICE_PAIR') {
      if (this.callbacks.onDevicePaired) {
        this.callbacks.onDevicePaired(packet as DevicePairPacket);
      }
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try { navigator.vibrate([60, 60, 120]); } catch {}
      }
    } else if (this.state !== 'RECEIVING' && this.state !== 'COMPLETE') {
      this.setState('RECEIVING');
    }

    if (result.isNew || !isConsecutiveDuplicate) {
      this.notifyProgress(packet);
    }

    if (result.isComplete && (this.state as ReceiverState) !== 'COMPLETE') {
      await this.handleCompletion();
    }
    return true;
  }

  private async handleCompletion() {
    const reconstructed = this.assembler.reconstruct();
    if (!reconstructed) {
      this.setState('ERROR', 'Full file integrity checksum mismatch');
      return;
    }

    const downloadUrl = URL.createObjectURL(reconstructed.blob);
    const isImage = reconstructed.mimeType.startsWith('image/') ||
      ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(reconstructed.fileExt);

    let textPreview: string | undefined = undefined;
    if (
      reconstructed.mimeType.startsWith('text/') ||
      ['txt', 'md', 'json', 'csv', 'js', 'ts', 'html'].includes(reconstructed.fileExt) ||
      reconstructed.fileBuffer.byteLength < 5000
    ) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(reconstructed.fileBuffer);
        textPreview = text.length > 500 ? text.substring(0, 500) + '...' : text;
      } catch { /* Binary file, no text preview */ }
    }

    this.reconstructedFile = {
      fileName: reconstructed.fileName,
      fileExt: reconstructed.fileExt,
      fileSize: reconstructed.fileBuffer.byteLength,
      mimeType: reconstructed.mimeType,
      transferId: reconstructed.transferId,
      checksum: reconstructed.checksum,
      blob: reconstructed.blob,
      downloadUrl,
      textPreview,
      isImage
    };

    this.setState('COMPLETE');
    this.notifyProgress(null);

    if (this.callbacks.onFileComplete) {
      this.callbacks.onFileComplete(this.reconstructedFile);
    }
  }

  private setState(state: ReceiverState, detail?: string) {
    this.state = state;
    if (this.callbacks.onStateChange) this.callbacks.onStateChange(state, detail);
  }

  private notifyProgress(latestPacket: ProtocolPacket | null) {
    if (this.callbacks.onProgress) {
      this.callbacks.onProgress(this.assembler.getProgress(), latestPacket);
    }
  }
}
