import QRCode from 'qrcode';
import {
  createTransferPackets,
  createPairingPacket,
  serializePacket,
  ProtocolPacket,
  PacketType,
  DEFAULT_CHUNK_SIZE,
  GridMode,
  GRID_SIZES,
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

// Error correction per grid: 4x4 and 3x3 use 'L' for max data density
// 2x2 uses 'M' for more robust scanning on larger individual QRs
const EC_LEVEL: Record<GridMode, 'L' | 'M'> = { '4x4': 'L', '3x3': 'L', '2x2': 'M' };
// QR pixel size per grid mode (individual slot)
const QR_SLOT_PX: Record<GridMode, number> = { '4x4': 200, '3x3': 260, '2x2': 380 };

export class OpticalSender {
  private file: File | null = null;
  private packets: ProtocolPacket[] = [];
  private currentPageIndex: number = 0;
  private loopCount: number = 0;
  private state: SenderState = 'IDLE';
  private fps: number = 3;
  private timerId: number | null = null;
  private gridContainer: HTMLElement | null = null;
  private slotCanvases: HTMLCanvasElement[] = [];
  private gridMode: GridMode = '3x3';
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
    if (options?.gridMode) this.gridMode = options.gridMode;
    this.onStateChangeCb = options?.onStateChange;
    this.onFrameChangeCb = options?.onFrameChange;

    // Support legacy single-canvas for sandbox
    if (options?.canvas) {
      this.gridContainer = null;
      // Create a pseudo-container around canvas
      const pseudoContainer = options.canvas.parentElement;
      if (pseudoContainer) this.gridContainer = pseudoContainer;
      // In sandbox mode, we just use the canvas element directly
      this.slotCanvases = [options.canvas];
    }
  }

  public attachCanvas(canvas: HTMLCanvasElement) {
    this.slotCanvases = [canvas];
  }

  public attachGridContainer(container: HTMLElement) {
    this.gridContainer = container;
  }

  private get pageSize(): number {
    return GRID_SIZES[this.gridMode];
  }

  public async loadFile(
    file: File,
    chunkSize: number = DEFAULT_CHUNK_SIZE
  ): Promise<void> {
    this.stop();
    this.file = file;
    this.currentPageIndex = 0;
    this.loopCount = 0;
    this.isPairingMode = false;

    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    this.packets = createTransferPackets(uint8, file.name, file.type || 'application/octet-stream', chunkSize);
    this.transferId = this.packets.length > 0 ? this.packets[0].transfer_id : '';
    this.setState('LOADED');
    await this.renderCurrentPage();
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
    this.currentPageIndex = 0;
    this.loopCount = 0;
    this.isPairingMode = false;
    if (this.packets.length > 0) {
      this.setState('STOPPED');
      this.renderCurrentPage();
    } else {
      this.setState('IDLE');
    }
  }

  public nextFrame() {
    if (this.packets.length === 0) return;
    const totalPages = this.getTotalPages();
    this.currentPageIndex = (this.currentPageIndex + 1) % totalPages;
    if (this.currentPageIndex === 0) this.loopCount++;
    this.renderCurrentPage();
  }

  public prevFrame() {
    if (this.packets.length === 0) return;
    const totalPages = this.getTotalPages();
    this.currentPageIndex = (this.currentPageIndex - 1 + totalPages) % totalPages;
    this.renderCurrentPage();
  }

  public seekFrame(index: number) {
    const totalPages = this.getTotalPages();
    if (index >= 0 && index < totalPages) {
      this.currentPageIndex = index;
      this.renderCurrentPage();
    }
  }

  public seekPage(pageIndex: number) {
    this.seekFrame(pageIndex);
  }

  public setFps(fps: number) {
    this.fps = Math.max(1, Math.min(15, fps));
    if (this.state === 'TRANSMITTING') {
      this.stopLoop();
      this.startLoop();
    }
    this.notifyFrameChange();
  }

  public getFps(): number { return this.fps; }

  public getPageSize(): number { return this.pageSize; }

  public getTotalPages(): number {
    if (this.packets.length === 0) return 1;
    // Total pages = ceil(packets / pageSize). But we show START and END on their own page.
    return Math.ceil(this.packets.length / this.pageSize);
  }

  public getCurrentPage(): number { return this.currentPageIndex; }

  public setGridMode(mode: GridMode) {
    if (this.gridMode === mode) return;
    this.gridMode = mode;
    this.currentPageIndex = 0;
    this.renderGridSlots();
    if (this.packets.length > 0) this.renderCurrentPage();
    this.notifyFrameChange();
  }

  public getGridMode(): GridMode { return this.gridMode; }

  public setCustomSlotCount(_count: number) {}
  public getCustomSlotCount(): number { return this.pageSize; }

  public setPageHoldSeconds(sec: number) {
    if (sec > 0) this.setFps(Math.round(1 / sec));
  }

  public getPageHoldSeconds(): number { return Number((1 / this.fps).toFixed(2)); }

  public getState(): SenderState { return this.state; }

  public getFrameInfo(): FrameInfo {
    const totalPages = this.getTotalPages();
    const pageStart = this.currentPageIndex * this.pageSize;
    const pagePackets = this.packets.slice(pageStart, pageStart + this.pageSize);
    const activeSlotsCount = pagePackets.length;
    const emptySlotsCount = this.pageSize - activeSlotsCount;

    const firstPacket = pagePackets[0] || null;
    let frameType: PacketType = firstPacket?.type || 'TRANSFER_START';

    return {
      frameIndex: this.currentPageIndex,
      totalFrames: totalPages,
      loopCount: this.loopCount,
      frameType,
      transferId: this.transferId,
      fileName: this.file?.name || '',
      fileExt: this.file ? this.file.name.split('.').pop() || '' : '',
      fileSize: this.file?.size || 0,
      fps: this.fps,
      packet: firstPacket,
      gridMode: this.gridMode,
      currentPage: this.currentPageIndex,
      totalPages,
      pageSize: this.pageSize,
      activeSlotsCount,
      emptySlotsCount,
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

  /**
   * Rebuild the DOM grid slots inside the container
   */
  public renderGridSlots() {
    if (!this.gridContainer) return;

    this.slotCanvases = [];
    this.gridContainer.innerHTML = '';
    this.gridContainer.className = `qr-grid-matrix grid-${this.gridMode}`;

    const count = this.pageSize;
    for (let i = 0; i < count; i++) {
      const slot = document.createElement('div');
      slot.className = 'qr-slot';
      slot.id = `qr-slot-${i}`;

      const canvas = document.createElement('canvas');
      canvas.className = 'qr-slot-canvas';
      canvas.width = QR_SLOT_PX[this.gridMode];
      canvas.height = QR_SLOT_PX[this.gridMode];
      slot.appendChild(canvas);

      this.gridContainer.appendChild(slot);
      this.slotCanvases.push(canvas);
    }
  }

  private async renderCurrentPage(): Promise<void> {
    if (this.isPairingMode) {
      this.notifyFrameChange();
      return;
    }

    if (this.packets.length === 0) {
      this.notifyFrameChange();
      return;
    }

    const pageStart = this.currentPageIndex * this.pageSize;
    const pagePackets = this.packets.slice(pageStart, pageStart + this.pageSize);
    const ecLevel = EC_LEVEL[this.gridMode];
    const qrPx = QR_SLOT_PX[this.gridMode];

    // Sandbox mode: single canvas — render first packet only
    if (this.gridContainer === null || (this.slotCanvases.length === 1 && !this.gridContainer)) {
      if (pagePackets[0] && this.slotCanvases[0]) {
        const qrData = serializePacket(pagePackets[0]);
        try {
          await QRCode.toCanvas(this.slotCanvases[0], qrData, {
            errorCorrectionLevel: ecLevel, margin: 2, width: 300,
            color: { dark: '#000000', light: '#ffffff' }
          });
        } catch (err) {
          console.error('[Sender] QR render error:', err);
        }
      }
      this.notifyFrameChange();
      return;
    }

    // Render each slot
    const renderPromises = this.slotCanvases.map(async (canvas, i) => {
      const slot = canvas.parentElement;
      if (i < pagePackets.length) {
        const packet = pagePackets[i];
        const qrData = serializePacket(packet);
        if (slot) {
          slot.className = 'qr-slot qr-slot-active';
          // Remove empty badge if any
          const emptyLabel = slot.querySelector('.qr-slot-empty');
          if (emptyLabel) emptyLabel.remove();
        }
        try {
          await QRCode.toCanvas(canvas, qrData, {
            errorCorrectionLevel: ecLevel, margin: 0, width: qrPx,
            color: { dark: '#000000', light: '#ffffff' }
          });
          canvas.style.display = 'block';
        } catch (err) {
          console.error(`[Sender] QR render error slot ${i}:`, err);
        }
      } else {
        // Empty slot
        if (slot) {
          slot.className = 'qr-slot qr-slot-empty';
          canvas.style.display = 'none';
          if (!slot.querySelector('.qr-slot-empty-label')) {
            const label = document.createElement('div');
            label.className = 'qr-slot-empty-label';
            label.textContent = '—';
            slot.appendChild(label);
          }
        }
      }
    });

    await Promise.all(renderPromises);
    this.notifyFrameChange();
  }

  public getPairingPacket(): ProtocolPacket {
    if (!this.transferId) {
      this.transferId = Math.random().toString(36).substring(2, 10);
    }
    return createPairingPacket(this.transferId, 'Luma Optical Sender', this.gridMode, this.pageSize);
  }

  public async renderPairingQr(): Promise<void> {
    this.stop();
    this.isPairingMode = true;
    const packet = this.getPairingPacket();
    const qrData = serializePacket(packet);

    if (this.gridContainer) {
      // Show pairing QR in center of grid
      this.gridContainer.innerHTML = '';
      this.gridContainer.className = 'qr-grid-matrix grid-pairing';
      const slot = document.createElement('div');
      slot.className = 'qr-slot qr-slot-active';
      slot.style.width = '100%';
      slot.style.maxWidth = '300px';
      slot.style.aspectRatio = '1';
      const canvas = document.createElement('canvas');
      canvas.width = 300;
      canvas.height = 300;
      slot.appendChild(canvas);
      this.gridContainer.appendChild(slot);
      try {
        await QRCode.toCanvas(canvas, qrData, {
          errorCorrectionLevel: 'H', margin: 2, width: 300,
          color: { dark: '#000000', light: '#ffffff' }
        });
      } catch (err) { console.error('[Sender] Pairing QR render error:', err); }
    } else if (this.slotCanvases[0]) {
      try {
        await QRCode.toCanvas(this.slotCanvases[0], qrData, {
          errorCorrectionLevel: 'H', margin: 2, width: 300,
          color: { dark: '#000000', light: '#ffffff' }
        });
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
