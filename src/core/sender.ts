import QRCode from 'qrcode';
import {
  createTransferPackets,
  createPairingPacket,
  serializePacket,
  ProtocolPacket,
  PacketType,
  DEFAULT_CHUNK_SIZE,
  GridMode,
} from './protocol';

export type SenderState = 'IDLE' | 'PAIRING' | 'LOADED' | 'TRANSMITTING' | 'PAUSED' | 'STOPPED';

export interface FrameInfo {
  frameIndex: number;
  totalFrames: number;
  loopCount: number;
  frameType: PacketType;
  transferId: string;
  fileName: string;
  fileExt: string;
  fileSize: number;
  fps: number;
  packet: ProtocolPacket | null;
  gridMode: GridMode;
  currentPage: number;
  totalPages: number;
  pageSize: number;
  activeSlotsCount: number;
  emptySlotsCount: number;
  pageHoldSeconds: number;
}

export class OpticalSender {
  private file: File | null = null;
  private packets: ProtocolPacket[] = [];
  private currentFrameIndex: number = 0;
  private loopCount: number = 0;
  private state: SenderState = 'IDLE';
  private fps: number = 60; // 60 FPS Turbo stream (matching Decimen)
  private timerId: number | null = null;
  private animFrameId: number | null = null;
  private lastTickTime: number = 0;
  private canvas: HTMLCanvasElement | null = null;
  private gridContainer: HTMLElement | null = null;
  private transferId: string = '';
  private isPairingMode: boolean = false;
  private preRenderedCanvases: Map<number, HTMLCanvasElement> = new Map();

  private onStateChangeCb?: (state: SenderState) => void;
  private onFrameChangeCb?: (info: FrameInfo) => void;

  constructor(options?: {
    canvas?: HTMLCanvasElement;
    fps?: number;
    gridMode?: GridMode;
    onStateChange?: (state: SenderState) => void;
    onFrameChange?: (info: FrameInfo) => void;
  }) {
    if (options?.fps) this.fps = options.fps;
    if (options?.canvas) this.canvas = options.canvas;
    this.onStateChangeCb = options?.onStateChange;
    this.onFrameChangeCb = options?.onFrameChange;
  }

  public attachCanvas(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  public attachGridContainer(container: HTMLElement) {
    this.gridContainer = container;
    // Find or create canvas inside container if needed
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
    chunkSize: number = DEFAULT_CHUNK_SIZE
  ): Promise<void> {
    this.stop();
    this.file = file;
    this.currentFrameIndex = 0;
    this.loopCount = 0;
    this.isPairingMode = false;
    this.preRenderedCanvases.clear();

    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    this.packets = createTransferPackets(uint8, file.name, file.type || 'application/octet-stream', chunkSize);
    this.transferId = this.packets.length > 0 ? this.packets[0].transfer_id : '';
    this.setState('LOADED');
    await this.renderCurrentFrame();
    this.startBackgroundPreRendering();
  }

  public start() {
    if (this.packets.length === 0) return;
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
    this.currentFrameIndex = 0;
    this.loopCount = 0;
    this.isPairingMode = false;
    if (this.packets.length > 0) {
      this.setState('STOPPED');
      this.renderCurrentFrame();
    } else {
      this.setState('IDLE');
    }
  }

  public nextFrame() {
    if (this.packets.length === 0) return;
    const total = this.packets.length;
    this.currentFrameIndex = (this.currentFrameIndex + 1) % total;
    if (this.currentFrameIndex === 0) this.loopCount++;
    this.renderCurrentFrame();
  }

  public prevFrame() {
    if (this.packets.length === 0) return;
    const total = this.packets.length;
    this.currentFrameIndex = (this.currentFrameIndex - 1 + total) % total;
    this.renderCurrentFrame();
  }

  public seekFrame(index: number) {
    if (index >= 0 && index < this.packets.length) {
      this.currentFrameIndex = index;
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

  public getPageSize(): number { return 1; }

  public getTotalPages(): number {
    return Math.max(1, this.packets.length);
  }

  public getCurrentPage(): number { return this.currentFrameIndex; }

  public setGridMode(_mode: GridMode) {
    this.notifyFrameChange();
  }

  public getGridMode(): GridMode { return '1x1'; }

  public setCustomSlotCount(_count: number) {}
  public getCustomSlotCount(): number { return 1; }

  public setPageHoldSeconds(sec: number) {
    if (sec > 0) this.setFps(Math.round(1 / sec));
  }

  public getPageHoldSeconds(): number { return Number((1 / this.fps).toFixed(2)); }

  public getState(): SenderState { return this.state; }

  public getFrameInfo(): FrameInfo {
    const total = this.packets.length;
    const packet = this.packets[this.currentFrameIndex] || null;
    const frameType: PacketType = packet?.type || 'TRANSFER_START';

    return {
      frameIndex: this.currentFrameIndex,
      totalFrames: total,
      loopCount: this.loopCount,
      frameType,
      transferId: this.transferId,
      fileName: this.file?.name || '',
      fileExt: this.file ? this.file.name.split('.').pop() || '' : '',
      fileSize: this.file?.size || 0,
      fps: this.fps,
      packet,
      gridMode: '1x1',
      currentPage: this.currentFrameIndex,
      totalPages: total,
      pageSize: 1,
      activeSlotsCount: 1,
      emptySlotsCount: 0,
      pageHoldSeconds: this.getPageHoldSeconds()
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
          // Adjust lastTickTime to preserve fractional remainder to prevent cumulative clock drift
          this.lastTickTime = now - (elapsed % frameInterval);
          this.nextFrame();
        }

        if (this.state === 'TRANSMITTING') {
          this.animFrameId = window.requestAnimationFrame(loop);
        }
      };

      this.animFrameId = window.requestAnimationFrame(loop);
    } else {
      // Fallback for tests / non-browser environments
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

  private async renderCurrentFrame(): Promise<void> {
    if (this.isPairingMode) {
      this.notifyFrameChange();
      return;
    }

    if (this.packets.length === 0 || !this.canvas) {
      this.notifyFrameChange();
      return;
    }

    const packet = this.packets[this.currentFrameIndex];
    if (!packet) return;

    // Fast-path: If pre-rendered canvas exists, blit immediately with zero QR compute lag
    const cached = this.preRenderedCanvases.get(this.currentFrameIndex);
    if (cached) {
      const ctx = this.canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(cached, 0, 0, this.canvas.width, this.canvas.height);
      }
      this.canvas.style.display = 'block';
    } else {
      const qrData = serializePacket(packet);
      try {
        await QRCode.toCanvas(this.canvas, qrData, {
          errorCorrectionLevel: 'M',
          margin: 0,
          width: 440,
          color: { dark: '#000000', light: '#ffffff' }
        });
        this.canvas.style.display = 'block';

        // Cache offscreen copy for 60 FPS repeat playback
        if (typeof document !== 'undefined') {
          const offscreen = document.createElement('canvas');
          offscreen.width = this.canvas.width || 440;
          offscreen.height = this.canvas.height || 440;
          const offCtx = offscreen.getContext('2d');
          if (offCtx) {
            offCtx.drawImage(this.canvas, 0, 0);
            this.preRenderedCanvases.set(this.currentFrameIndex, offscreen);
          }
        }
      } catch (err) {
        console.error('[Sender] QR render error:', err);
      }
    }

    this.notifyFrameChange();
  }

  private startBackgroundPreRendering() {
    if (typeof document === 'undefined' || this.packets.length === 0) return;

    let idx = 0;
    const total = this.packets.length;

    const renderBatch = () => {
      if (this.packets.length !== total) return; // File replaced

      const batchSize = 10;
      const end = Math.min(idx + batchSize, total);

      for (; idx < end; idx++) {
        const i = idx;
        if (this.preRenderedCanvases.has(i)) continue;
        const packet = this.packets[i];
        if (!packet) continue;

        const offscreen = document.createElement('canvas');
        offscreen.width = 440;
        offscreen.height = 440;
        const qrData = serializePacket(packet);

        QRCode.toCanvas(offscreen, qrData, {
          errorCorrectionLevel: 'M',
          margin: 0,
          width: 440,
          color: { dark: '#000000', light: '#ffffff' }
        }).then(() => {
          this.preRenderedCanvases.set(i, offscreen);
        }).catch(() => {});
      }

      if (idx < total) {
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

  public getPairingPacket(): ProtocolPacket {
    if (!this.transferId) {
      this.transferId = Math.random().toString(36).substring(2, 10);
    }
    return createPairingPacket(this.transferId, 'LumaAir', '1x1', 1);
  }

  public async renderPairingQr(): Promise<void> {
    this.stop();
    this.isPairingMode = true;
    const packet = this.getPairingPacket();
    const qrData = serializePacket(packet);

    if (this.canvas) {
      try {
        await QRCode.toCanvas(this.canvas, qrData, {
          errorCorrectionLevel: 'H',
          margin: 0,
          width: 440,
          color: { dark: '#000000', light: '#ffffff' }
        });
        this.canvas.style.display = 'block';
      } catch (err) { console.error('[Sender] Pairing QR render error:', err); }
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
