import jsQR from 'jsqr';
import {
  parsePacket,
  TransferAssembler,
  TransferProgress,
  ProtocolPacket,
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
  onFileComplete?: (file: ReconstructedFile) => void;
  onFrameRejected?: (packet: ProtocolPacket, reason: string) => void;
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

    // Initialize native BarcodeDetector if available
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
   * Scan directly from a source canvas (e.g. for loopback simulator or screen capture)
   */
  public startCanvasScan(sourceCanvas: HTMLCanvasElement) {
    this.stop();
    this.setState('SCANNING');

    const scanStep = async () => {
      const curState = this.state as ReceiverState;
      if (curState === 'COMPLETE' || curState === 'IDLE') return;
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

    // Scan native BarcodeDetector if supported
    if (this.barcodeDetector) {
      try {
        const barcodes = await this.barcodeDetector.detect(this.videoElement);
        if (barcodes && barcodes.length > 0) {
          for (const barcode of barcodes) {
            if (barcode.rawValue) {
              await this.handleRawQrData(barcode.rawValue);
              return;
            }
          }
        }
      } catch {
        // Fall back to jsQR
      }
    }

    // jsQR fallback with scaled canvas for fast CPU decoding
    const maxDim = 640;
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

  private async processImageData(imgData: ImageData) {
    const code = jsQR(imgData.data, imgData.width, imgData.height, {
      inversionAttempts: 'dontInvert'
    });

    if (code && code.data) {
      await this.handleRawQrData(code.data);
    }
  }

  private async handleRawQrData(rawData: string) {
    const packet = parsePacket(rawData);
    if (!packet) return;

    const frameKey = `${packet.transfer_id}_${packet.type}_${(packet as any).seq ?? 0}`;
    const isConsecutiveDuplicate = this.lastScannedKey === frameKey;
    this.lastScannedKey = frameKey;

    const result: AddPacketResult = this.assembler.addPacket(packet);

    if (!result.accepted) {
      if (this.callbacks.onFrameRejected && result.rejectedReason) {
        this.callbacks.onFrameRejected(packet, result.rejectedReason);
      }
      this.notifyProgress(packet);
      return;
    }

    if (this.state !== 'RECEIVING' && this.state !== 'COMPLETE') {
      this.setState('RECEIVING');
    }

    if (result.isNew || !isConsecutiveDuplicate) {
      this.notifyProgress(packet);
    }

    if (result.isComplete && (this.state as ReceiverState) !== 'COMPLETE') {
      await this.handleCompletion();
    }
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
      } catch {
        // Binary file, no text preview
      }
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
    if (this.callbacks.onStateChange) {
      this.callbacks.onStateChange(state, detail);
    }
  }

  private notifyProgress(latestPacket: ProtocolPacket | null) {
    if (this.callbacks.onProgress) {
      this.callbacks.onProgress(this.assembler.getProgress(), latestPacket);
    }
  }
}
