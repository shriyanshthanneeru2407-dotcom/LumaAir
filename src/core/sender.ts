import QRCode from 'qrcode';
import {
  createTransferPackets,
  createPairingPacket,
  serializePacket,
  ProtocolPacket,
  PacketType,
  DEFAULT_CHUNK_SIZE,
  MODULES_PER_BATCH,
  BatchFramePacket
} from './protocol';

export type SenderState = 'IDLE' | 'PAIRING' | 'LOADED' | 'TRANSMITTING' | 'PAUSED' | 'STOPPED';
export type GridMode = '1x1';

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
  // 1x1 Single QR Batch Telemetry (16 modules bundled in 1 QR)
  gridMode: '1x1';
  batchIndex: number;
  totalBatches: number;
  batchModulesCount: number;
  modulesRange: string;
  // Backward compatibility fields
  currentPage: number;
  totalPages: number;
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
  private fps: number = 3; // 3 FPS default for 1x1 QR streaming
  private timerId: number | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private transferId: string = '';

  private onStateChangeCb?: (state: SenderState) => void;
  private onFrameChangeCb?: (info: FrameInfo) => void;

  constructor(options?: {
    canvas?: HTMLCanvasElement;
    fps?: number;
    gridMode?: string;
    onStateChange?: (state: SenderState) => void;
    onFrameChange?: (info: FrameInfo) => void;
  }) {
    if (options?.canvas) this.canvas = options.canvas;
    if (options?.fps) this.fps = options.fps;
    this.onStateChangeCb = options?.onStateChange;
    this.onFrameChangeCb = options?.onFrameChange;
  }

  public attachCanvas(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    if (this.packets.length > 0) {
      this.renderCurrentFrame();
    }
  }

  public attachGridContainer(_container: HTMLElement) {
    // Single 1x1 QR mode renders directly on canvas
  }

  public async loadFile(
    file: File,
    chunkSize: number = DEFAULT_CHUNK_SIZE,
    modulesPerBatch: number = MODULES_PER_BATCH
  ): Promise<void> {
    this.stop();
    this.file = file;
    this.currentFrameIndex = 0;
    this.loopCount = 0;

    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    this.packets = createTransferPackets(
      uint8,
      file.name,
      file.type || 'application/octet-stream',
      chunkSize,
      modulesPerBatch
    );
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
    if (this.packets.length > 0) {
      this.setState('STOPPED');
      this.renderCurrentFrame();
    } else {
      this.setState('IDLE');
    }
  }

  public nextFrame() {
    if (this.packets.length === 0) return;
    this.currentFrameIndex = (this.currentFrameIndex + 1) % this.packets.length;
    if (this.currentFrameIndex === 0) this.loopCount++;
    this.renderCurrentFrame();
  }

  public prevFrame() {
    if (this.packets.length === 0) return;
    this.currentFrameIndex = (this.currentFrameIndex - 1 + this.packets.length) % this.packets.length;
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
    this.fps = Math.max(1, Math.min(12, fps));
    if (this.state === 'TRANSMITTING') {
      this.stopLoop();
      this.startLoop();
    }
    this.notifyFrameChange();
  }

  public getFps(): number {
    return this.fps;
  }

  public getPageSize(): number {
    return 1;
  }

  public getTotalPages(): number {
    return this.packets.length || 1;
  }

  public getCurrentPage(): number {
    return this.currentFrameIndex;
  }

  public setGridMode(_mode: any) {
    // Strictly 1x1 single QR mode
  }

  public getGridMode(): '1x1' {
    return '1x1';
  }

  public setCustomSlotCount(_count: number) {}
  public getCustomSlotCount(): number {
    return MODULES_PER_BATCH;
  }

  public setPageHoldSeconds(sec: number) {
    if (sec > 0) {
      this.setFps(Math.round(1 / sec));
    }
  }

  public getPageHoldSeconds(): number {
    return Number((1 / this.fps).toFixed(2));
  }

  public getState(): SenderState {
    return this.state;
  }

  public getFrameInfo(): FrameInfo {
    const curPacket = this.packets[this.currentFrameIndex] || null;
    let batchIndex = 0;
    let totalBatches = 0;
    let batchModulesCount = 0;
    let modulesRange = '';

    if (curPacket && curPacket.type === 'BATCH_FRAME') {
      const bp = curPacket as BatchFramePacket;
      batchIndex = bp.batch_index;
      totalBatches = bp.total_batches;
      batchModulesCount = bp.modules.length;
      if (bp.modules.length > 0) {
        const firstSeq = bp.modules[0].seq + 1;
        const lastSeq = bp.modules[bp.modules.length - 1].seq + 1;
        modulesRange = `Modules ${firstSeq}–${lastSeq} of ${bp.total_chunks}`;
      }
    }

    return {
      frameIndex: this.currentFrameIndex,
      totalFrames: this.packets.length,
      loopCount: this.loopCount,
      frameType: this.state === 'PAIRING' ? 'DEVICE_PAIR' : (curPacket?.type || 'TRANSFER_START'),
      transferId: this.transferId,
      fileName: this.file?.name || '',
      fileExt: this.file ? this.file.name.split('.').pop() || '' : '',
      fileSize: this.file?.size || 0,
      fps: this.fps,
      packet: curPacket,
      gridMode: '1x1',
      batchIndex,
      totalBatches,
      batchModulesCount,
      modulesRange,
      currentPage: this.currentFrameIndex,
      totalPages: this.packets.length || 1,
      activeSlotsCount: 1,
      emptySlotsCount: 0,
      pageHoldSeconds: this.getPageHoldSeconds()
    };
  }

  private startLoop() {
    this.stopLoop();
    const intervalMs = Math.round(1000 / this.fps);
    const setTimer = typeof window !== 'undefined' ? window.setInterval.bind(window) : setInterval;
    this.timerId = setTimer(() => {
      this.nextFrame();
    }, intervalMs) as any;
  }

  private stopLoop() {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  private async renderCurrentFrame(): Promise<void> {
    if (this.packets.length === 0 || !this.canvas) {
      this.notifyFrameChange();
      return;
    }

    const currentPacket = this.packets[this.currentFrameIndex];
    if (currentPacket) {
      const qrData = serializePacket(currentPacket);
      try {
        await QRCode.toCanvas(this.canvas, qrData, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 400,
          color: {
            dark: '#000000',
            light: '#ffffff'
          }
        });
      } catch (err) {
        console.error('[OpticalSender] 1x1 QR Render error:', err);
      }
    }

    this.notifyFrameChange();
  }

  public getPairingPacket(): ProtocolPacket {
    if (!this.transferId) {
      this.transferId = Math.random().toString(36).substring(2, 10);
    }
    return createPairingPacket(
      this.transferId,
      'Luma Optical Sender',
      '1x1',
      MODULES_PER_BATCH
    );
  }

  public async renderPairingQr(): Promise<void> {
    this.stop();
    const packet = this.getPairingPacket();
    const qrData = serializePacket(packet);

    if (this.canvas) {
      await QRCode.toCanvas(this.canvas, qrData, {
        errorCorrectionLevel: 'H',
        margin: 2,
        width: 400,
        color: { dark: '#000000', light: '#ffffff' }
      });
    }

    this.setState('PAIRING');
    this.notifyFrameChange();
  }

  private setState(state: SenderState) {
    this.state = state;
    if (this.onStateChangeCb) this.onStateChangeCb(state);
  }

  private notifyFrameChange() {
    if (this.onFrameChangeCb) {
      this.onFrameChangeCb(this.getFrameInfo());
    }
  }
}
