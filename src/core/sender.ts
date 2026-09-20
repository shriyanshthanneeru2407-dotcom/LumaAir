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
  private fps: number = 6; // Fast, smooth animated stream (like Decimen)
  private timerId: number | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private gridContainer: HTMLElement | null = null;
  private transferId: string = '';
  private isPairingMode: boolean = false;

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

    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    this.packets = createTransferPackets(uint8, file.name, file.type || 'application/octet-stream', chunkSize);
    this.transferId = this.packets.length > 0 ? this.packets[0].transfer_id : '';
    this.setState('LOADED');
    await this.renderCurrentFrame();
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
    this.fps = Math.max(1, Math.min(20, fps));
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
    const intervalMs = Math.round(1000 / this.fps);
    const setTimer = typeof window !== 'undefined' ? window.setInterval.bind(window) : setInterval;
    this.timerId = setTimer(() => { this.nextFrame(); }, intervalMs) as any;
  }

  private stopLoop() {
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

    const qrData = serializePacket(packet);
    try {
      await QRCode.toCanvas(this.canvas, qrData, {
        errorCorrectionLevel: 'M',
        margin: 0,
        width: 440,
        color: { dark: '#000000', light: '#ffffff' }
      });
      this.canvas.style.display = 'block';
    } catch (err) {
      console.error('[Sender] QR render error:', err);
    }

    this.notifyFrameChange();
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
