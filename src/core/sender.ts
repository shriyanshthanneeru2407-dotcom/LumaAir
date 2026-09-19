import QRCode from 'qrcode';
import {
  createTransferPackets,
  serializePacket,
  ProtocolPacket,
  PacketType,
  DEFAULT_CHUNK_SIZE
} from './protocol';

export type SenderState = 'IDLE' | 'LOADED' | 'TRANSMITTING' | 'PAUSED' | 'STOPPED';

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
}

export class OpticalSender {
  private file: File | null = null;
  private packets: ProtocolPacket[] = [];
  private currentFrameIndex: number = 0;
  private loopCount: number = 0;
  private state: SenderState = 'IDLE';
  private fps: number = 4; // Default 4 frames per second
  private timerId: number | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private transferId: string = '';

  private onStateChangeCb?: (state: SenderState) => void;
  private onFrameChangeCb?: (info: FrameInfo) => void;

  constructor(options?: {
    canvas?: HTMLCanvasElement;
    fps?: number;
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

  public async loadFile(file: File, chunkSize: number = DEFAULT_CHUNK_SIZE): Promise<void> {
    this.stop();
    this.file = file;
    this.currentFrameIndex = 0;
    this.loopCount = 0;

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

  public setFps(fps: number) {
    this.fps = Math.max(1, Math.min(15, fps));
    if (this.state === 'TRANSMITTING') {
      this.stopLoop();
      this.startLoop();
    }
    this.notifyFrameChange();
  }

  public getState(): SenderState {
    return this.state;
  }

  public getFps(): number {
    return this.fps;
  }

  public getFrameInfo(): FrameInfo {
    const curPacket = this.packets[this.currentFrameIndex] || null;
    return {
      frameIndex: this.currentFrameIndex,
      totalFrames: this.packets.length,
      loopCount: this.loopCount,
      frameType: curPacket?.type || 'TRANSFER_START',
      transferId: this.transferId,
      fileName: this.file?.name || '',
      fileExt: this.file ? this.file.name.split('.').pop() || '' : '',
      fileSize: this.file?.size || 0,
      fps: this.fps,
      packet: curPacket
    };
  }

  private startLoop() {
    this.stopLoop();
    const intervalMs = Math.round(1000 / this.fps);
    this.timerId = window.setInterval(() => {
      this.nextFrame();
    }, intervalMs);
  }

  private stopLoop() {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  private async renderCurrentFrame(): Promise<void> {
    if (!this.canvas || this.packets.length === 0) {
      this.notifyFrameChange();
      return;
    }

    const currentPacket = this.packets[this.currentFrameIndex];
    const qrData = serializePacket(currentPacket);

    try {
      await QRCode.toCanvas(this.canvas, qrData, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 360,
        color: {
          dark: '#000000',
          light: '#ffffff'
        }
      });
    } catch (err) {
      console.error('[OpticalSender] QR Render error:', err);
    }

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
