import jsQR from 'jsqr';
import {
  readBarcodesFromImageData,
  prepareZXingModule,
  setZXingModuleOverrides,
} from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import {
  parseFrame,
  streamIdentity,
  unpackFile,
  verifyFile,
  fnv1a,
  LTDecoder,
  FrameHeader,
} from './protocol';

if (typeof window !== 'undefined') {
  setZXingModuleOverrides({
    locateFile: (path: string, prefix: string) => {
      if (path.endsWith('.wasm')) return wasmUrl;
      return prefix + path;
    },
  });
  try {
    prepareZXingModule();
  } catch {}
}

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

export interface ReceiverDiagnostics {
  captureFps: number;
  decodeFps: number;
  goodput: number;
  elapsed: number;
  framesNew: number;
  framesDup: number;
  blocksK: number;
  blockLen: number;
  transferBytes: number;
  progressPercent: number;
  etaSeconds: number | null;
}

export interface ReceiverCallbacks {
  onStateChange?: (state: ReceiverState, detail?: string) => void;
  onProgress?: (progress: ReceiverProgress, header: FrameHeader | null) => void;
  onDiagnostics?: (diag: ReceiverDiagnostics) => void;
  onDevicePaired?: (sessionId: number) => void;
  onNoSignal?: (visible: boolean) => void;
  onFileComplete?: (file: ReconstructedFile) => void;
  onError?: (err: Error) => void;
}

interface TrackedRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  seen: number;
  decoded: boolean;
  drift?: number;
}

const INDICATOR_FADE_MS = 700;
const REGION_TTL_MS = 1500;
const FULL_SCAN_INTERVAL_MS = 1500;
const ACQUISITION_SCAN_MS = 100;
const REGION_PAD = 0.35;
const NO_SIGNAL_MS = 8000;

export class OpticalReceiver {
  private state: ReceiverState = 'IDLE';
  private videoElement: HTMLVideoElement | null = null;
  private overlayCanvas: HTMLCanvasElement | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;
  private mediaStream: MediaStream | null = null;
  private grabCanvas: HTMLCanvasElement;
  private grabCtx: CanvasRenderingContext2D | null;
  private animFrameId: number | null = null;
  private scanTimeoutId: any = null;
  private statsTimerId: any = null;
  private callbacks: ReceiverCallbacks = {};
  private reconstructedFile: ReconstructedFile | null = null;
  private isProcessing = false;

  private decoder: LTDecoder | null = null;
  private streamKey: string = '';
  private pairedSessionId: number | null = null;
  private startTs: number = 0;
  private lastDecodeTs: number = 0;

  // Diagnostics tracking
  private captureTimes: number[] = [];
  private decodeTimes: number[] = [];
  private framesNewCount = 0;
  private framesDupCount = 0;
  private latestSeq = 0;
  private lastFullScan = 0;
  private regions: TrackedRegion[] = [];

  constructor(callbacks?: ReceiverCallbacks) {
    if (callbacks) this.callbacks = callbacks;
    if (typeof document !== 'undefined') {
      this.grabCanvas = document.createElement('canvas');
      this.grabCtx = this.grabCanvas.getContext('2d', { willReadFrequently: true });
    } else {
      this.grabCanvas = null as any;
      this.grabCtx = null;
    }
  }

  public setOverlayCanvas(canvas: HTMLCanvasElement | null) {
    this.overlayCanvas = canvas;
    this.overlayCtx = canvas ? canvas.getContext('2d') : null;
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
    facingMode: 'environment' | 'user' = 'environment',
    overlayCanvas?: HTMLCanvasElement,
    idealWidth = 1280,
    idealFps = 60
  ): Promise<void> {
    this.stop();
    this.videoElement = videoElement;
    if (overlayCanvas) {
      this.setOverlayCanvas(overlayCanvas);
    }

    this.setState('STARTING');

    const selection: MediaTrackConstraints = deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: facingMode } };

    const base: MediaTrackConstraints = {
      ...selection,
      width: { ideal: idealWidth },
      height: { ideal: Math.round((idealWidth * 3) / 4) },
    };

    try {
      // Decimen standard: Demand exact 60fps first, fall back to ideal
      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { ...base, frameRate: { exact: idealFps } },
        });
      } catch {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { ...base, frameRate: { ideal: idealFps } },
        });
      }

      this.videoElement.srcObject = this.mediaStream;
      await this.videoElement.play();

      // Continuous autofocus
      const track = this.mediaStream.getVideoTracks()[0];
      if (track) {
        try {
          const caps = (track as any).getCapabilities?.();
          if (caps?.focusMode?.includes?.('continuous')) {
            await (track as any).applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
          }
        } catch {}
      }

      this.lastDecodeTs = performance.now();
      this.setState('SCANNING');
      this.startHardwareScanLoop();
      this.startDiagnosticsTimer();
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

      if (sourceCanvas.width > 0 && sourceCanvas.height > 0) {
        const srcCtx = sourceCanvas.getContext('2d');
        if (srcCtx) {
          const imgData = srcCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
          await this.decodeImageData(imgData, 0, 0);
        }
      }

      const postState = this.state as ReceiverState;
      if (postState !== 'COMPLETE' && postState !== 'IDLE') {
        this.scanTimeoutId = window.setTimeout(scanStep, 35);
      }
    };

    scanStep();
  }

  public stop() {
    if (this.scanTimeoutId !== null) {
      clearTimeout(this.scanTimeoutId);
      this.scanTimeoutId = null;
    }
    if (this.statsTimerId) {
      clearInterval(this.statsTimerId);
      this.statsTimerId = null;
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
    if (this.overlayCanvas && this.overlayCtx) {
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }
    this.isProcessing = false;
    this.regions = [];
    this.setState('IDLE');
  }

  public resetTransfer() {
    this.decoder = null;
    this.streamKey = '';
    this.pairedSessionId = null;
    this.framesNewCount = 0;
    this.framesDupCount = 0;
    this.regions = [];
    if (this.reconstructedFile?.downloadUrl) {
      URL.revokeObjectURL(this.reconstructedFile.downloadUrl);
    }
    this.reconstructedFile = null;
    if (this.state === 'COMPLETE') {
      this.setState('SCANNING');
      this.startHardwareScanLoop();
      this.startDiagnosticsTimer();
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

  private startHardwareScanLoop() {
    const loop = () => {
      const curState = this.state as ReceiverState;
      if (!this.videoElement || curState === 'COMPLETE' || curState === 'IDLE' || curState === 'ERROR') {
        return;
      }

      const now = performance.now();
      this.drawOverlay(now);

      if (this.videoElement.readyState >= 2 && !this.isProcessing) {
        this.isProcessing = true;
        this.captureAndDecodeFrame(now)
          .catch(() => {})
          .finally(() => {
            this.isProcessing = false;
          });
      }

      // Check no-signal timeout
      if (this.state === 'SCANNING' && now - this.lastDecodeTs > NO_SIGNAL_MS) {
        this.callbacks.onNoSignal?.(true);
      }

      const postState = this.state as ReceiverState;
      if (postState !== 'COMPLETE' && postState !== 'IDLE' && postState !== 'ERROR') {
        if ('requestVideoFrameCallback' in this.videoElement) {
          (this.videoElement as any).requestVideoFrameCallback(loop);
        } else {
          this.animFrameId = requestAnimationFrame(loop);
        }
      }
    };

    if (this.videoElement && 'requestVideoFrameCallback' in this.videoElement) {
      (this.videoElement as any).requestVideoFrameCallback(loop);
    } else {
      this.animFrameId = requestAnimationFrame(loop);
    }
  }

  private async captureAndDecodeFrame(now: number) {
    if (!this.videoElement || !this.grabCtx) return;
    const vw = this.videoElement.videoWidth;
    const vh = this.videoElement.videoHeight;
    if (!vw || !vh) return;

    this.captureTimes.push(now);

    // Prune stale regions
    for (let i = this.regions.length - 1; i >= 0; i--) {
      if (now - this.regions[i].seen > REGION_TTL_MS) {
        this.regions.splice(i, 1);
      }
    }

    const liveCount = this.regions.filter(r => r.decoded).length;
    const scanInterval = liveCount === 0 ? ACQUISITION_SCAN_MS : FULL_SCAN_INTERVAL_MS;
    const fullScanDue = now - this.lastFullScan > scanInterval;

    if (this.grabCanvas.width !== vw || this.grabCanvas.height !== vh) {
      this.grabCanvas.width = vw;
      this.grabCanvas.height = vh;
    }

    this.grabCtx.drawImage(this.videoElement, 0, 0);

    // Crop tracking path
    if (!fullScanDue && this.regions.length > 0) {
      const r = this.regions[0];
      const size = Math.max(r.w, r.h);
      const pad = Math.round(size * REGION_PAD + Math.min(size, 2 * (r.drift ?? 0)));
      const x = Math.max(0, Math.floor(r.x - pad));
      const y = Math.max(0, Math.floor(r.y - pad));
      const w = Math.min(vw - x, Math.ceil(r.w + 2 * pad));
      const h = Math.min(vh - y, Math.ceil(r.h + 2 * pad));

      if (w >= 64 && h >= 64) {
        const cropImg = this.grabCtx.getImageData(x, y, w, h);
        const decoded = await this.decodeImageData(cropImg, x, y);
        if (decoded) return;
      }
    }

    // Full frame scan path
    this.lastFullScan = now;
    const fullImg = this.grabCtx.getImageData(0, 0, vw, vh);
    await this.decodeImageData(fullImg, 0, 0);
  }

  private async decodeImageData(imgData: ImageData, ox: number, oy: number): Promise<boolean> {
    try {
      const results = await readBarcodesFromImageData(imgData, {
        formats: ['QRCode'],
        tryHarder: false,
        maxNumberOfSymbols: 1,
      });

      if (results && results.length > 0) {
        const res = results[0];
        const bytes = res.bytes;
        if (bytes && bytes.length > 0) {
          const pos = res.position;
          const xs = [pos.topLeft.x, pos.topRight.x, pos.bottomRight.x, pos.bottomLeft.x];
          const ys = [pos.topLeft.y, pos.topRight.y, pos.bottomRight.y, pos.bottomLeft.y];
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          const minY = Math.min(...ys);
          const maxY = Math.max(...ys);

          const box: TrackedRegion = {
            x: ox + minX,
            y: oy + minY,
            w: maxX - minX,
            h: maxY - minY,
            seen: performance.now(),
            decoded: true,
          };
          this.noteRegion(box);
          await this.handleRawBytes(bytes);
          return true;
        }
      }
    } catch {
      // Fallback to jsQR
      try {
        const qr = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: 'dontInvert' });
        if (qr && qr.binaryData && qr.binaryData.length > 0) {
          const bytes = Uint8Array.from(qr.binaryData);
          await this.handleRawBytes(bytes);
          return true;
        }
      } catch {}
    }
    return false;
  }

  private noteRegion(box: TrackedRegion) {
    const now = box.seen;
    for (const r of this.regions) {
      const dx = Math.abs(box.x + box.w / 2 - (r.x + r.w / 2));
      const dy = Math.abs(box.y + box.h / 2 - (r.y + r.h / 2));
      if (dx < Math.max(box.w, r.w) / 2 && dy < Math.max(box.h, r.h) / 2) {
        r.drift = 0.5 * (r.drift ?? 0) + 0.5 * Math.hypot(dx, dy);
        r.x = box.x;
        r.y = box.y;
        r.w = box.w;
        r.h = box.h;
        r.seen = now;
        r.decoded = true;
        return;
      }
    }
    this.regions.push(box);
    if (this.regions.length > 4) {
      this.regions.sort((a, b) => b.seen - a.seen);
      this.regions.length = 4;
    }
  }

  private drawOverlay(now: number) {
    if (!this.overlayCanvas || !this.overlayCtx || !this.videoElement) return;
    const cvs = this.overlayCanvas;
    const ctx = this.overlayCtx;
    const cw = cvs.clientWidth;
    const ch = cvs.clientHeight;
    const vw = this.videoElement.videoWidth;
    const vh = this.videoElement.videoHeight;
    if (!cw || !ch || !vw || !vh) return;

    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(cw * dpr);
    const ph = Math.round(ch * dpr);
    if (cvs.width !== pw || cvs.height !== ph) {
      cvs.width = pw;
      cvs.height = ph;
    }

    ctx.clearRect(0, 0, pw, ph);

    // Letterbox mapping (contain)
    const scale = Math.min(pw / vw, ph / vh);
    const offX = (pw - vw * scale) / 2;
    const offY = (ph - vh * scale) / 2;

    ctx.lineWidth = Math.max(3, 3 * dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let anyActive = false;

    // Draw Decimen corner brackets around tracked regions
    for (const r of this.regions) {
      const age = now - r.seen;
      if (age > INDICATOR_FADE_MS) continue;
      anyActive = true;

      const color = '#54ff7e'; // Neon green
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 6 * dpr;

      const pad = 0.06 * Math.max(r.w, r.h) * scale;
      const x = offX + r.x * scale - pad;
      const y = offY + r.y * scale - pad;
      const w = r.w * scale + 2 * pad;
      const h = r.h * scale + 2 * pad;
      const len = Math.max(14 * dpr, 0.22 * Math.min(w, h));

      ctx.globalAlpha = Math.max(0, 1 - age / INDICATOR_FADE_MS);

      ctx.beginPath();
      // TL
      ctx.moveTo(x, y + len);
      ctx.lineTo(x, y);
      ctx.lineTo(x + len, y);
      // TR
      ctx.moveTo(x + w - len, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w, y + len);
      // BR
      ctx.moveTo(x + w, y + h - len);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x + w - len, y + h);
      // BL
      ctx.moveTo(x + len, y + h);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x, y + h - len);
      ctx.stroke();
    }

    // Default aiming guides when searching
    if (!anyActive) {
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#00ff66';
      ctx.shadowColor = '#00ff66';
      ctx.shadowBlur = 4 * dpr;
      ctx.lineWidth = Math.max(2, 2 * dpr);

      const retSize = Math.min(pw, ph) * 0.6;
      const rx = (pw - retSize) / 2;
      const ry = (ph - retSize) / 2;
      const rlen = retSize * 0.16;

      ctx.beginPath();
      ctx.moveTo(rx, ry + rlen);
      ctx.lineTo(rx, ry);
      ctx.lineTo(rx + rlen, ry);

      ctx.moveTo(rx + retSize - rlen, ry);
      ctx.lineTo(rx + retSize, ry);
      ctx.lineTo(rx + retSize, ry + rlen);

      ctx.moveTo(rx + retSize, ry + retSize - rlen);
      ctx.lineTo(rx + retSize, ry + retSize);
      ctx.lineTo(rx + retSize - rlen, ry + retSize);

      ctx.moveTo(rx + rlen, ry + retSize);
      ctx.lineTo(rx, ry + retSize);
      ctx.lineTo(rx, ry + retSize - rlen);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  public async handleRawBytes(bytes: Uint8Array): Promise<boolean> {
    const parsed = parseFrame(bytes);
    if (!parsed) return false;

    const { header, block } = parsed;
    const now = performance.now();
    this.decodeTimes.push(now);
    this.lastDecodeTs = now;
    this.callbacks.onNoSignal?.(false);

    // Check if this is a pairing beacon
    const isPairingBeacon = (header.flags & 0x80) !== 0 ||
      (header.totalLen === 16 && block.length === 16 && new TextDecoder().decode(block.slice(0, 7)) === 'LumaAir');

    if (isPairingBeacon) {
      if (this.pairedSessionId !== header.sessionId) {
        this.pairedSessionId = header.sessionId;
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          try { navigator.vibrate([80, 50, 80]); } catch {}
        }
        this.callbacks.onDevicePaired?.(header.sessionId);
      }
      return true; // Pairing acknowledged! Keep receiver actively SCANNING for main file stream!
    }

    const identity = streamIdentity(header);

    if (!this.decoder || this.streamKey !== identity) {
      this.decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
      this.streamKey = identity;
      this.startTs = now;
      this.framesNewCount = 0;
      this.framesDupCount = 0;
      this.setState('RECEIVING');
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try { navigator.vibrate([60, 60, 100]); } catch {}
      }
    }

    this.latestSeq = header.seq;
    const prevSolved = this.decoder.solvedCount;
    this.decoder.addFrame(header.seq, block);
    const newSolved = this.decoder.solvedCount;

    if (newSolved > prevSolved) {
      this.framesNewCount++;
    } else {
      this.framesDupCount++;
    }

    const pct = Math.min(100, Math.round((this.decoder.solvedCount / this.decoder.k) * 100));

    if (this.callbacks.onProgress) {
      this.callbacks.onProgress({
        k: this.decoder.k,
        solvedCount: this.decoder.solvedCount,
        framesNew: this.framesNewCount,
        framesDup: this.framesDupCount,
        framesRedundant: this.decoder.framesRedundant,
        percent: pct,
        sessionId: header.sessionId,
        totalLen: header.totalLen,
        latestSeq: this.latestSeq,
      }, header);
    }

    if (this.decoder.isComplete) {
      const containerBytes = this.decoder.assemble();
      if (containerBytes) {
        const payloadHash = fnv1a(containerBytes);
        if (payloadHash === header.payloadFnv) {
          await this.finishTransfer(containerBytes, header.sessionId);
          return true;
        } else {
          console.warn('[Receiver] Container checksum mismatch');
        }
      }
    }

    return true;
  }

  private async finishTransfer(containerBytes: Uint8Array, sessionId: number) {
    this.setState('COMPLETE');
    try {
      const opticalFile = await unpackFile(containerBytes);
      const isChecksumValid = await verifyFile(opticalFile);

      if (!isChecksumValid) {
        console.error('[Receiver] SHA-256 verification failed!');
        this.setState('ERROR', 'SHA-256 verification failed');
        return;
      }

      const fileBuffer = opticalFile.bytes.buffer.slice(
        opticalFile.bytes.byteOffset,
        opticalFile.bytes.byteOffset + opticalFile.bytes.byteLength
      ) as ArrayBuffer;
      const blob = new Blob([fileBuffer], { type: opticalFile.type || 'application/octet-stream' });
      const downloadUrl = (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function')
        ? URL.createObjectURL(blob)
        : '';

      let textPreview: string | undefined;
      const isImg = opticalFile.type.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(opticalFile.name);

      if (opticalFile.type.startsWith('text/') || opticalFile.type === 'application/json' || /\.(txt|md|json|js|ts|html|css|py)$/i.test(opticalFile.name)) {
        try {
          const sample = opticalFile.bytes.slice(0, 4000);
          textPreview = new TextDecoder('utf-8').decode(sample);
        } catch {}
      }

      this.reconstructedFile = {
        fileName: opticalFile.name,
        fileExt: opticalFile.name.split('.').pop()?.toUpperCase() || 'BIN',
        fileSize: opticalFile.bytes.length,
        transmittedSize: containerBytes.length,
        compression: opticalFile.compression,
        mimeType: opticalFile.type,
        sessionId,
        downloadUrl,
        textPreview,
        isImage: isImg,
      };

      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try { navigator.vibrate([100, 50, 100, 50, 200]); } catch {}
      }

      if (this.callbacks.onFileComplete) {
        this.callbacks.onFileComplete(this.reconstructedFile);
      }
    } catch (err: any) {
      console.error('[Receiver] Unpack error:', err);
      this.setState('ERROR', `Unpack failed: ${err.message}`);
    }
  }

  private startDiagnosticsTimer() {
    if (this.statsTimerId) clearInterval(this.statsTimerId);
    this.statsTimerId = setInterval(() => {
      this.emitDiagnostics();
    }, 500);
  }

  private emitDiagnostics() {
    const now = performance.now();
    const windowMs = 2000;
    while (this.captureTimes.length > 0 && now - this.captureTimes[0] > windowMs) {
      this.captureTimes.shift();
    }
    while (this.decodeTimes.length > 0 && now - this.decodeTimes[0] > windowMs) {
      this.decodeTimes.shift();
    }

    const capFps = Math.round((this.captureTimes.length / windowMs) * 1000);
    const decFps = Math.round((this.decodeTimes.length / windowMs) * 1000);
    const elapsed = this.startTs > 0 ? (now - this.startTs) / 1000 : 0;

    let goodput = 0;
    let eta: number | null = null;
    let k = 0;
    let blockLen = 1465;
    let totalLen = 0;
    let pct = 0;

    if (this.decoder) {
      k = this.decoder.k;
      blockLen = this.decoder.blockLen;
      totalLen = this.decoder.totalLen;
      pct = Math.min(100, Math.round((this.decoder.solvedCount / this.decoder.k) * 100));

      if (elapsed > 0.5) {
        goodput = Math.round((this.decoder.solvedCount * blockLen) / elapsed);
        const remainingBlocks = this.decoder.k - this.decoder.solvedCount;
        if (remainingBlocks > 0 && decFps > 0) {
          eta = Math.max(0.1, +(remainingBlocks / decFps).toFixed(1));
        } else if (remainingBlocks === 0) {
          eta = 0;
        }
      }
    }

    this.callbacks.onDiagnostics?.({
      captureFps: capFps,
      decodeFps: decFps,
      goodput,
      elapsed: +elapsed.toFixed(1),
      framesNew: this.framesNewCount,
      framesDup: this.framesDupCount,
      blocksK: k,
      blockLen,
      transferBytes: totalLen,
      progressPercent: pct,
      etaSeconds: eta,
    });
  }

  private setState(newState: ReceiverState, detail?: string) {
    this.state = newState;
    if (this.callbacks.onStateChange) {
      this.callbacks.onStateChange(newState, detail);
    }
  }

  public getState(): ReceiverState {
    return this.state;
  }
}
