import jsQR from 'jsqr';
import {
  parseFrame,
  streamIdentity,
  unpackFile,
  verifyFile,
  fnv1a,
  LTDecoder,
  FrameHeader,
  OpticalFile,
} from './protocol';

export type ReceiverState = 'IDLE' | 'STARTING' | 'SCANNING' | 'RECEIVING' | 'COMPLETE' | 'ERROR';

export interface ReconstructedFile {
  fileName: string;
  fileExt: string;
  fileSize: number;
  transmittedSize: number;
  compression: string;
  mimeType: string;
  sessionId: number;
  downloadUrl: string;
  textPreview?: string;
  isImage?: boolean;
}

export interface ReceiverProgress {
  k: number;
  solvedCount: number;
  framesNew: number;
  framesDup: number;
  framesRedundant: number;
  percent: number;
  sessionId: number;
  totalLen: number;
  latestSeq: number;
}

export interface ReceiverCallbacks {
  onStateChange?: (state: ReceiverState, detail?: string) => void;
  onProgress?: (progress: ReceiverProgress, header: FrameHeader | null) => void;
  onFileComplete?: (file: ReconstructedFile) => void;
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
  private callbacks: ReceiverCallbacks = {};
  private reconstructedFile: ReconstructedFile | null = null;
  private barcodeDetector: any = null;
  private isDetecting = false;

  private decoder: LTDecoder | null = null;
  private streamKey: string = '';

  constructor(callbacks?: ReceiverCallbacks) {
    if (callbacks) this.callbacks = callbacks;
    this.scanCanvas = document.createElement('canvas');
    this.scanCtx = this.scanCanvas.getContext('2d', { willReadFrequently: true });

    if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
      try {
        this.barcodeDetector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
      } catch (e) {
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
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }
        : { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }
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

  public startCanvasScan(sourceCanvas: HTMLCanvasElement) {
    this.stop();
    this.setState('SCANNING');

    const scanStep = async () => {
      const curState = this.state as ReceiverState;
      if (curState === 'COMPLETE' || curState === 'IDLE') return;

      if (this.barcodeDetector) {
        try {
          const barcodes = await this.barcodeDetector.detect(sourceCanvas);
          if (barcodes && barcodes.length > 0) {
            for (const barcode of barcodes) {
              const rawBytes = barcode.rawBytes || this.stringToBytes(barcode.rawValue);
              if (rawBytes) await this.handleRawBytes(rawBytes);
            }
          }
        } catch {}
      }

      // jsQR scan
      if (sourceCanvas.width > 0 && sourceCanvas.height > 0) {
        const srcCtx = sourceCanvas.getContext('2d');
        if (srcCtx) {
          const imgData = srcCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
          const qr = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: 'attemptBoth' });
          if (qr && qr.binaryData && qr.binaryData.length > 0) {
            await this.handleRawBytes(Uint8Array.from(qr.binaryData));
          } else if (qr && qr.data) {
            await this.handleRawBytes(this.stringToBytes(qr.data));
          }
        }
      }

      const postState = this.state as ReceiverState;
      if (postState !== 'COMPLETE' && postState !== 'IDLE') {
        this.scanIntervalId = window.setTimeout(scanStep, 40);
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
    this.decoder = null;
    this.streamKey = '';
    if (this.reconstructedFile?.downloadUrl) {
      URL.revokeObjectURL(this.reconstructedFile.downloadUrl);
    }
    this.reconstructedFile = null;
    if (this.state === 'COMPLETE') {
      this.setState('SCANNING');
      if (this.videoElement && this.mediaStream) {
        this.startVideoScanLoop();
      }
    }
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
          console.error('[Receiver] Scan error:', e);
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

    if (this.barcodeDetector) {
      try {
        const barcodes = await this.barcodeDetector.detect(this.videoElement);
        if (barcodes && barcodes.length > 0) {
          for (const barcode of barcodes) {
            const rawBytes = barcode.rawBytes || this.stringToBytes(barcode.rawValue);
            if (rawBytes) await this.handleRawBytes(rawBytes);
          }
          return;
        }
      } catch {}
    }

    const maxDim = 1000;
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
    const qr = jsQR(imgData.data, targetW, targetH, { inversionAttempts: 'attemptBoth' });
    if (qr && qr.binaryData && qr.binaryData.length > 0) {
      await this.handleRawBytes(Uint8Array.from(qr.binaryData));
    } else if (qr && qr.data) {
      await this.handleRawBytes(this.stringToBytes(qr.data));
    }
  }

  private stringToBytes(str: string): Uint8Array {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      bytes[i] = str.charCodeAt(i) & 0xff;
    }
    return bytes;
  }

  public async handleRawBytes(bytes: Uint8Array): Promise<boolean> {
    const parsed = parseFrame(bytes);
    if (!parsed) return false;

    const { header, block } = parsed;
    const identity = streamIdentity(header);

    if (!this.decoder || this.streamKey !== identity) {
      this.decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
      this.streamKey = identity;
      this.setState('RECEIVING');
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try { navigator.vibrate([60, 60, 100]); } catch {}
      }
    }

    this.decoder.addFrame(header.seq, block);
    this.notifyProgress(header);

    if (this.decoder.isComplete && (this.state as ReceiverState) !== 'COMPLETE') {
      await this.handleCompletion(header);
    }

    return true;
  }

  private notifyProgress(header: FrameHeader | null) {
    if (!this.decoder || !this.callbacks.onProgress) return;
    const percent = Math.min(100, Math.round((this.decoder.solvedCount / this.decoder.k) * 100));
    this.callbacks.onProgress({
      k: this.decoder.k,
      solvedCount: this.decoder.solvedCount,
      framesNew: this.decoder.framesNew,
      framesDup: this.decoder.framesDup,
      framesRedundant: this.decoder.framesRedundant,
      percent,
      sessionId: header?.sessionId || 0,
      totalLen: header?.totalLen || 0,
      latestSeq: header?.seq || 0,
    }, header);
  }

  private async handleCompletion(header: FrameHeader) {
    if (!this.decoder) return;
    const container = this.decoder.assemble();
    if (!container) return;

    if (fnv1a(container) !== header.payloadFnv) {
      this.setState('ERROR', 'Stream integrity checksum mismatch');
      return;
    }

    try {
      const file: OpticalFile = await unpackFile(container);
      const ok = await verifyFile(file);
      if (!ok) {
        this.setState('ERROR', 'Full file SHA-256 integrity verification failed');
        return;
      }

      const blob = new Blob([file.bytes as BlobPart], { type: file.type });
      const downloadUrl = URL.createObjectURL(blob);
      const isImage = file.type.startsWith('image/') ||
        ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(file.name.split('.').pop() || '');

      let textPreview: string | undefined = undefined;
      if (file.type.startsWith('text/') || file.bytes.length < 5000) {
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
          textPreview = text.length > 500 ? text.substring(0, 500) + '...' : text;
        } catch {}
      }

      this.reconstructedFile = {
        fileName: file.name,
        fileExt: file.name.split('.').pop() || '',
        fileSize: file.bytes.length,
        transmittedSize: file.transmittedSize,
        compression: file.compression,
        mimeType: file.type,
        sessionId: header.sessionId,
        downloadUrl,
        textPreview,
        isImage,
      };

      this.setState('COMPLETE');
      if (this.callbacks.onFileComplete) {
        this.callbacks.onFileComplete(this.reconstructedFile);
      }
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try { navigator.vibrate([100, 50, 100, 50, 200]); } catch {}
      }
    } catch (err: any) {
      console.error('[Receiver] Unpack error:', err);
      this.setState('ERROR', err.message || 'Failed to unpack file');
    }
  }

  private setState(state: ReceiverState, detail?: string) {
    this.state = state;
    if (this.callbacks.onStateChange) this.callbacks.onStateChange(state, detail);
  }
}
