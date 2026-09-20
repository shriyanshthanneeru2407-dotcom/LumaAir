import QRCode from 'qrcode';
import {
  packFile,
  packFrame,
  LTEncoder,
  cycleLength,
  blockLength,
  fnv1a,
  DEFAULT_FRAME_BYTES,
  FrameHeader,
  PackedOpticalFile,
  CompressionMode,
  getFileExtension,
} from './protocol';

export type SenderState = 'IDLE' | 'PAIRING' | 'LOADED' | 'TRANSMITTING' | 'PAUSED' | 'STOPPED';

export interface FrameInfo {
  frameIndex: number; // seq
  totalFrames: number; // k (source blocks)
  cycleFrames: number; // 2 * k
  loopCount: number;
  sessionId: number;
  fileName: string;
  fileExt: string;
  fileSize: number;
  transmittedSize: number;
  compression: CompressionMode;
  fps: number;
  frameBytes: number;
  seq: number;
  isRepairFrame: boolean;
  activeSlotsCount: number;
  emptySlotsCount: number;
  pageHoldSeconds: number;
  gridMode: string;
  currentPage: number;
  totalPages: number;
  pageSize: number;
}

export class OpticalSender {
  private file: File | null = null;
  private packed: PackedOpticalFile | null = null;
  private encoder: LTEncoder | null = null;
  private sessionId: number = 0;
  private payloadFnv: number = 0;
  private k: number = 0;
  private blockLen: number = 0;
  private frameBytes: number = DEFAULT_FRAME_BYTES;

  private currentSeq: number = 0;
  private loopCount: number = 0;
  private state: SenderState = 'IDLE';
  private fps: number = 60; // 60 FPS Decimen Turbo
  private timerId: number | null = null;
  private animFrameId: number | null = null;
  private lastTickTime: number = 0;
  private canvas: HTMLCanvasElement | null = null;
  private gridContainer: HTMLElement | null = null;
  private isPairingMode: boolean = false;

  private preRenderedCanvases: Map<number, HTMLCanvasElement> = new Map();
  private onStateChangeCb?: (state: SenderState) => void;
  private onFrameChangeCb?: (info: FrameInfo) => void;

  constructor(options?: {
    canvas?: HTMLCanvasElement;
    fps?: number;
    frameBytes?: number;
    onStateChange?: (state: SenderState) => void;
    onFrameChange?: (info: FrameInfo) => void;
  }) {
    if (options?.fps) this.fps = options.fps;
    if (options?.frameBytes) this.frameBytes = options.frameBytes;
    if (options?.canvas) this.canvas = options.canvas;
    this.onStateChangeCb = options?.onStateChange;
    this.onFrameChangeCb = options?.onFrameChange;
  }

  public attachCanvas(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  public attachGridContainer(container: HTMLElement) {
    this.gridContainer = container;
    let canvas = container.querySelector('canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'sender-single-canvas';
      canvas.className = 'qr-single-canvas';
      canvas.width = 440;
      canvas.height = 440;
      container.appendChild(canvas);
    }
    this.canvas = canvas;
  }

  public renderGridSlots() {
    if (this.gridContainer) {
      this.gridContainer.innerHTML = '';
      const canvas = document.createElement('canvas');
      canvas.id = 'sender-single-canvas';
      canvas.className = 'qr-single-canvas';
      canvas.width = 440;
      canvas.height = 440;
      this.gridContainer.appendChild(canvas);
      this.canvas = canvas;
    }
  }

  public async loadFile(
    file: File,
    frameBytes: number = this.frameBytes
  ): Promise<void> {
    this.stop();
    this.file = file;
    this.frameBytes = frameBytes;
    this.currentSeq = 0;
    this.loopCount = 0;
    this.isPairingMode = false;
    this.preRenderedCanvases.clear();

    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    this.packed = await packFile(file.name, file.type || 'application/octet-stream', uint8);
    this.blockLen = blockLength(this.frameBytes);
    this.sessionId = (Math.random() * 0xffff) & 0xffff;
    this.payloadFnv = fnv1a(this.packed.container);
    this.encoder = new LTEncoder(this.packed.container, this.blockLen, this.sessionId);
    this.k = this.encoder.k;

    this.setState('LOADED');
    await this.renderCurrentFrame();
    this.startBackgroundPreRendering();
  }

  public start() {
    if (!this.encoder || this.k === 0) return;
    if (this.state === 'TRANSMITTING') return;
    this.setState('TRANSMITTING');
    this.startLoop();
  }

  public pause() {
    if (this.state !== 'TRANSMITTING') return;
    this.stopLoop();
    this.setState('PAUSED');
  }

  public resume() {
    if (this.state !== 'PAUSED') return;
    this.setState('TRANSMITTING');
    this.startLoop();
  }

  public stop() {
    this.stopLoop();
    this.currentSeq = 0;
    this.loopCount = 0;
    this.isPairingMode = false;
    if (this.encoder && this.k > 0) {
      this.setState('STOPPED');
      this.renderCurrentFrame();
    } else {
      this.setState('IDLE');
    }
  }

  public nextFrame() {
    if (!this.encoder || this.k === 0) return;
    const cycle = cycleLength(this.k);
    this.currentSeq++;
    if (this.currentSeq % cycle === 0) {
      this.loopCount++;
    }
    this.renderCurrentFrame();
  }

  public prevFrame() {
    if (!this.encoder || this.k === 0) return;
    if (this.currentSeq > 0) {
      this.currentSeq--;
    }
    this.renderCurrentFrame();
  }

  public seekFrame(index: number) {
    if (this.encoder && index >= 0) {
      this.currentSeq = index;
      this.renderCurrentFrame();
    }
  }

  public seekPage(pageIndex: number) {
    this.seekFrame(pageIndex);
  }

  public setFps(fps: number) {
    this.fps = Math.max(1, Math.min(60, fps));
    if (this.state === 'TRANSMITTING') {
      this.stopLoop();
      this.startLoop();
    }
    this.notifyFrameChange();
  }

  public getFps(): number { return this.fps; }

  public setFrameBytes(bytes: number) {
    this.frameBytes = bytes;
    if (this.file) {
      this.loadFile(this.file, bytes);
    }
  }

  public getFrameBytes(): number { return this.frameBytes; }
  public getPageSize(): number { return 1; }
  public getTotalPages(): number { return this.k; }
  public getCurrentPage(): number { return this.currentSeq % Math.max(1, this.k); }
  public setGridMode(_mode: any) { this.notifyFrameChange(); }
  public getGridMode(): string { return '1x1'; }
  public setCustomSlotCount(_count: number) {}
  public getCustomSlotCount(): number { return 1; }
  public setPageHoldSeconds(sec: number) {
    if (sec > 0) this.setFps(Math.round(1 / sec));
  }
  public getPageHoldSeconds(): number { return Number((1 / this.fps).toFixed(2)); }
  public getState(): SenderState { return this.state; }

  public getFrameInfo(): FrameInfo {
    const cycle = Math.max(1, cycleLength(this.k));
    const posInCycle = this.k > 0 ? this.currentSeq % cycle : 0;
    const isRepair = this.k > 0 && posInCycle >= this.k;

    return {
      frameIndex: this.currentSeq,
      totalFrames: this.k,
      cycleFrames: cycle,
      loopCount: this.loopCount,
      sessionId: this.sessionId,
      fileName: this.file?.name || '',
      fileExt: this.file ? getFileExtension(this.file.name) : '',
      fileSize: this.file?.size || 0,
      transmittedSize: this.packed?.transmittedSize || 0,
      compression: this.packed?.compression || 'none',
      fps: this.fps,
      frameBytes: this.frameBytes,
      seq: this.currentSeq,
      isRepairFrame: isRepair,
      activeSlotsCount: 1,
      emptySlotsCount: 0,
      pageHoldSeconds: this.getPageHoldSeconds(),
      gridMode: '1x1',
      currentPage: this.currentSeq % Math.max(1, this.k),
      totalPages: this.k,
      pageSize: 1,
    };
  }

  private startLoop() {
    this.stopLoop();
    this.lastTickTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

    if (typeof window !== 'undefined' && window.requestAnimationFrame) {
      const loop = (now: number) => {
        if (this.state !== 'TRANSMITTING') return;

        const frameInterval = 1000 / this.fps;
        const elapsed = now - this.lastTickTime;

        if (elapsed >= frameInterval) {
          this.lastTickTime = now - (elapsed % frameInterval);
          this.nextFrame();
        }

        if (this.state === 'TRANSMITTING') {
          this.animFrameId = window.requestAnimationFrame(loop);
        }
      };

      this.animFrameId = window.requestAnimationFrame(loop);
    } else {
      const intervalMs = Math.max(1, Math.round(1000 / this.fps));
      const setTimer = typeof window !== 'undefined' ? window.setInterval.bind(window) : setInterval;
      this.timerId = setTimer(() => { this.nextFrame(); }, intervalMs) as any;
    }
  }

  private stopLoop() {
    if (this.animFrameId !== null && typeof window !== 'undefined' && window.cancelAnimationFrame) {
      window.cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  private renderQrDataToCanvas(bytes: Uint8Array, targetCanvas: HTMLCanvasElement) {
    // Pinned mask pattern 4 for 4x fast generation
    const qr = QRCode.create([{ data: bytes, mode: 'byte' } as unknown as QRCode.QRCodeSegment], {
      errorCorrectionLevel: 'L',
      maskPattern: 4,
    });

    const modCount = qr.modules.size;
    const margin = 4;
    const size = modCount + 2 * margin;

    if (typeof document !== 'undefined') {
      const offscreen = document.createElement('canvas');
      offscreen.width = size;
      offscreen.height = size;
      const offCtx = offscreen.getContext('2d')!;
      const imgData = offCtx.createImageData(size, size);
      const data32 = new Uint32Array(imgData.data.buffer);
      data32.fill(0xffffffff); // White background

      const BLACK = 0xff000000;
      for (let y = 0; y < modCount; y++) {
        const row = (y + margin) * size + margin;
        const src = y * modCount;
        for (let x = 0; x < modCount; x++) {
          if (qr.modules.data[src + x]) {
            data32[row + x] = BLACK;
          }
        }
      }
      offCtx.putImageData(imgData, 0, 0);

      targetCanvas.width = 440;
      targetCanvas.height = 440;
      const ctx = targetCanvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(offscreen, 0, 0, 440, 440);
      targetCanvas.style.display = 'block';
    }
  }

  private async renderCurrentFrame(): Promise<void> {
    if (this.isPairingMode) {
      this.notifyFrameChange();
      return;
    }

    if (!this.encoder || !this.packed || !this.canvas || this.k === 0) {
      this.notifyFrameChange();
      return;
    }

    // Check pre-render cache
    const cacheKey = this.currentSeq % Math.max(1, cycleLength(this.k));
    const cached = this.preRenderedCanvases.get(cacheKey);
    if (cached) {
      const ctx = this.canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(cached, 0, 0, this.canvas.width, this.canvas.height);
      }
      this.canvas.style.display = 'block';
      this.notifyFrameChange();
      return;
    }

    const block = this.encoder.encode(this.currentSeq);
    const header: FrameHeader = {
      sessionId: this.sessionId,
      seq: this.currentSeq,
      k: this.k,
      blockLen: this.blockLen,
      totalLen: this.packed.container.length,
      payloadFnv: this.payloadFnv,
      flags: 0,
    };

    const wireBytes = packFrame(header, block);

    try {
      this.renderQrDataToCanvas(wireBytes, this.canvas);

      // Cache for repeat loops
      if (typeof document !== 'undefined') {
        const off = document.createElement('canvas');
        off.width = 440;
        off.height = 440;
        const octx = off.getContext('2d')!;
        octx.drawImage(this.canvas, 0, 0);
        this.preRenderedCanvases.set(cacheKey, off);
      }
    } catch (err) {
      console.error('[Sender] QR render error:', err);
    }

    this.notifyFrameChange();
  }

  private startBackgroundPreRendering() {
    if (typeof document === 'undefined' || !this.encoder || !this.packed) return;

    const totalToPreRender = Math.min(this.k, 80); // Pre-render initial systematic sweep
    let idx = 0;
    const curSession = this.sessionId;

    const renderBatch = () => {
      if (this.sessionId !== curSession || !this.encoder || !this.packed) return;

      const batchSize = 6;
      const end = Math.min(idx + batchSize, totalToPreRender);

      for (; idx < end; idx++) {
        const s = idx;
        if (this.preRenderedCanvases.has(s)) continue;

        const block = this.encoder.encode(s);
        const header: FrameHeader = {
          sessionId: this.sessionId,
          seq: s,
          k: this.k,
          blockLen: this.blockLen,
          totalLen: this.packed.container.length,
          payloadFnv: this.payloadFnv,
          flags: 0,
        };
        const wireBytes = packFrame(header, block);
        const offscreen = document.createElement('canvas');
        this.renderQrDataToCanvas(wireBytes, offscreen);
        this.preRenderedCanvases.set(s, offscreen);
      }

      if (idx < totalToPreRender) {
        if (typeof requestIdleCallback !== 'undefined') {
          requestIdleCallback(renderBatch);
        } else {
          setTimeout(renderBatch, 4);
        }
      }
    };

    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(renderBatch);
    } else {
      setTimeout(renderBatch, 4);
    }
  }

  public async renderPairingQr(): Promise<void> {
    this.stop();
    this.isPairingMode = true;

    // Pairing / alignment beacon: sends a self-describing 0-byte beacon block with session ID
    if (!this.sessionId) {
      this.sessionId = (Math.random() * 0xffff) & 0xffff;
    }
    const beaconBlock = new Uint8Array(16);
    beaconBlock.set(new TextEncoder().encode('LumaAir'));
    const header: FrameHeader = {
      sessionId: this.sessionId,
      seq: 0,
      k: 1,
      blockLen: 16,
      totalLen: 16,
      payloadFnv: fnv1a(beaconBlock),
      flags: 0,
    };
    const wireBytes = packFrame(header, beaconBlock);

    if (this.canvas) {
      try {
        this.renderQrDataToCanvas(wireBytes, this.canvas);
      } catch (err) {
        console.error('[Sender] Beacon render error:', err);
      }
    }

    this.setState('PAIRING');
    this.notifyFrameChange();
  }

  private setState(state: SenderState) {
    this.state = state;
    if (this.onStateChangeCb) this.onStateChangeCb(state);
  }

  private notifyFrameChange() {
    if (this.onFrameChangeCb) this.onFrameChangeCb(this.getFrameInfo());
  }
}
