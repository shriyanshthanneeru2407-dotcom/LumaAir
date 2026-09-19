import QRCode from 'qrcode';
import {
  createTransferPackets,
  createPairingPacket,
  serializePacket,
  ProtocolPacket,
  PacketType,
  DEFAULT_CHUNK_SIZE
} from './protocol';

export type SenderState = 'IDLE' | 'PAIRING' | 'LOADED' | 'TRANSMITTING' | 'PAUSED' | 'STOPPED';
export type GridMode = '1x1' | '2x2' | '3x3' | '4x4' | 'custom';

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
  // Grid mode telemetry
  gridMode: GridMode;
  currentPage: number;
  totalPages: number;
  pageHoldSeconds: number;
  activeSlotsCount: number;
  emptySlotsCount: number;
}

export class OpticalSender {
  private file: File | null = null;
  private packets: ProtocolPacket[] = [];
  private currentFrameIndex: number = 0;
  private loopCount: number = 0;
  private state: SenderState = 'IDLE';
  private fps: number = 4; // FPS for 1x1 mode
  private pageHoldSeconds: number = 1.5; // Seconds per page for 2x2, 3x3 & 4x4
  private timerId: number | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private gridContainer: HTMLElement | null = null;
  private transferId: string = '';
  private gridMode: GridMode = '3x3'; // Default to 3x3 9-QR matrix as recommended sweet spot
  private customSlotCount: number = 9;

  private onStateChangeCb?: (state: SenderState) => void;
  private onFrameChangeCb?: (info: FrameInfo) => void;

  constructor(options?: {
    canvas?: HTMLCanvasElement;
    gridContainer?: HTMLElement;
    fps?: number;
    pageHoldSeconds?: number;
    gridMode?: GridMode;
    onStateChange?: (state: SenderState) => void;
    onFrameChange?: (info: FrameInfo) => void;
  }) {
    if (options?.canvas) this.canvas = options.canvas;
    if (options?.gridContainer) this.gridContainer = options.gridContainer;
    if (options?.fps) this.fps = options.fps;
    if (options?.pageHoldSeconds) this.pageHoldSeconds = options.pageHoldSeconds;
    if (options?.gridMode) this.gridMode = options.gridMode;
    this.onStateChangeCb = options?.onStateChange;
    this.onFrameChangeCb = options?.onFrameChange;
  }

  public attachGridContainer(container: HTMLElement) {
    this.gridContainer = container;
    if (this.packets.length > 0) {
      this.renderCurrentFrame();
    }
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

  public getPageSize(): number {
    if (this.gridMode === '4x4') return 16;
    if (this.gridMode === '3x3') return 9;
    if (this.gridMode === '2x2') return 4;
    if (this.gridMode === 'custom') return this.customSlotCount;
    return 1;
  }

  public setCustomSlotCount(count: number) {
    this.customSlotCount = Math.max(1, Math.min(36, Math.round(count)));
    if (this.gridMode === 'custom') {
      this.setGridMode('custom');
    }
  }

  public getCustomSlotCount(): number {
    return this.customSlotCount;
  }

  public getTotalPages(): number {
    if (this.packets.length === 0) return 1;
    return Math.ceil(this.packets.length / this.getPageSize());
  }

  public getCurrentPage(): number {
    return Math.floor(this.currentFrameIndex / this.getPageSize());
  }

  public setGridMode(mode: GridMode) {
    this.gridMode = mode;
    // Align frame index to start of page
    const pageSize = this.getPageSize();
    const curPage = Math.floor(this.currentFrameIndex / pageSize);
    this.currentFrameIndex = curPage * pageSize;
    if (this.state === 'TRANSMITTING') {
      this.stopLoop();
      this.startLoop();
    }
    this.renderCurrentFrame();
  }

  public getGridMode(): GridMode {
    return this.gridMode;
  }

  public setPageHoldSeconds(sec: number) {
    this.pageHoldSeconds = Math.max(0.5, Math.min(5, sec));
    if (this.state === 'TRANSMITTING' && this.gridMode !== '1x1') {
      this.stopLoop();
      this.startLoop();
    }
    this.notifyFrameChange();
  }

  public getPageHoldSeconds(): number {
    return this.pageHoldSeconds;
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
    const pageSize = this.getPageSize();
    const totalPages = this.getTotalPages();

    if (this.gridMode === '1x1') {
      this.currentFrameIndex = (this.currentFrameIndex + 1) % this.packets.length;
      if (this.currentFrameIndex === 0) this.loopCount++;
    } else {
      const curPage = Math.floor(this.currentFrameIndex / pageSize);
      const nextPage = (curPage + 1) % totalPages;
      this.currentFrameIndex = nextPage * pageSize;
      if (nextPage === 0) this.loopCount++;
    }
    this.renderCurrentFrame();
  }

  public prevFrame() {
    if (this.packets.length === 0) return;
    const pageSize = this.getPageSize();
    const totalPages = this.getTotalPages();

    if (this.gridMode === '1x1') {
      this.currentFrameIndex = (this.currentFrameIndex - 1 + this.packets.length) % this.packets.length;
    } else {
      const curPage = Math.floor(this.currentFrameIndex / pageSize);
      const prevPage = (curPage - 1 + totalPages) % totalPages;
      this.currentFrameIndex = prevPage * pageSize;
    }
    this.renderCurrentFrame();
  }

  public seekFrame(index: number) {
    if (index >= 0 && index < this.packets.length) {
      this.currentFrameIndex = index;
      this.renderCurrentFrame();
    }
  }

  public seekPage(pageIndex: number) {
    const totalPages = this.getTotalPages();
    if (pageIndex >= 0 && pageIndex < totalPages) {
      this.currentFrameIndex = pageIndex * this.getPageSize();
      this.renderCurrentFrame();
    }
  }

  public setFps(fps: number) {
    this.fps = Math.max(1, Math.min(15, fps));
    if (this.state === 'TRANSMITTING' && this.gridMode === '1x1') {
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
    const pageSize = this.getPageSize();
    const totalPages = this.getTotalPages();
    const curPage = this.getCurrentPage();
    const pageStartIndex = curPage * pageSize;
    let activeSlots = 0;
    for (let i = 0; i < pageSize; i++) {
      if (pageStartIndex + i < this.packets.length) activeSlots++;
    }
    const emptySlots = pageSize - activeSlots;

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
      gridMode: this.gridMode,
      currentPage: curPage,
      totalPages: totalPages,
      pageHoldSeconds: this.pageHoldSeconds,
      activeSlotsCount: activeSlots,
      emptySlotsCount: emptySlots
    };
  }

  private startLoop() {
    this.stopLoop();
    const intervalMs = this.gridMode === '1x1'
      ? Math.round(1000 / this.fps)
      : Math.round(this.pageHoldSeconds * 1000);

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
    if (this.packets.length === 0) {
      this.notifyFrameChange();
      return;
    }

    // Render single canvas if attached
    if (this.canvas) {
      const currentPacket = this.packets[this.currentFrameIndex];
      if (currentPacket) {
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
          console.error('[OpticalSender] Single canvas QR Render error:', err);
        }
      }
    }

    // Render multi-slot grid if gridContainer is attached
    if (this.gridContainer) {
      await this.renderGridSlots();
    }

    this.notifyFrameChange();
  }

  private async renderGridSlots(): Promise<void> {
    if (!this.gridContainer) return;

    const pageSize = this.getPageSize();
    const curPage = this.getCurrentPage();
    const startIndex = curPage * pageSize;

    this.gridContainer.className = `qr-grid-matrix grid-${this.gridMode}`;
    this.gridContainer.removeAttribute('style');
    this.gridContainer.innerHTML = '';

    if (this.gridMode === 'custom') {
      const cols = Math.ceil(Math.sqrt(pageSize));
      const rows = Math.ceil(pageSize / cols);
      this.gridContainer.style.setProperty('grid-template-columns', `repeat(${cols}, 1fr)`, 'important');
      this.gridContainer.style.setProperty('grid-template-rows', `repeat(${rows}, 1fr)`, 'important');
    }

    const slotRenderPromises: Promise<void>[] = [];

    for (let slot = 0; slot < pageSize; slot++) {
      const packetIdx = startIndex + slot;
      const isPopulated = packetIdx < this.packets.length;

      const cellEl = document.createElement('div');
      cellEl.className = `qr-slot ${isPopulated ? 'qr-slot-active' : 'qr-slot-empty'}`;
      cellEl.dataset.slotIndex = `${slot}`;

      if (isPopulated) {
        const packet = this.packets[packetIdx];
        const canvas = document.createElement('canvas');
        canvas.className = 'qr-slot-canvas';

        // Badge indicator
        const badge = document.createElement('div');
        badge.className = 'qr-slot-badge';
        if (packet.type === 'TRANSFER_START') {
          badge.textContent = 'START';
          badge.classList.add('badge-start');
        } else if (packet.type === 'TRANSFER_END') {
          badge.textContent = 'END';
          badge.classList.add('badge-end');
        } else {
          badge.textContent = `#${(packet as any).seq + 1}`;
          badge.classList.add('badge-data');
        }

        cellEl.appendChild(canvas);
        cellEl.appendChild(badge);
        this.gridContainer.appendChild(cellEl);

        let qrWidth = 140;
        let qrMargin = 1;
        if (this.gridMode === '4x4') {
          qrWidth = 140;
          qrMargin = 1;
        } else if (this.gridMode === '3x3') {
          qrWidth = 180;
          qrMargin = 2;
        } else if (this.gridMode === '2x2') {
          qrWidth = 220;
          qrMargin = 2;
        } else if (this.gridMode === '1x1') {
          qrWidth = 360;
          qrMargin = 2;
        } else if (this.gridMode === 'custom') {
          const cols = Math.ceil(Math.sqrt(pageSize));
          qrWidth = Math.max(90, Math.min(240, Math.floor(520 / cols)));
          qrMargin = cols > 3 ? 1 : 2;
        }

        const p = QRCode.toCanvas(canvas, serializePacket(packet), {
          errorCorrectionLevel: 'M',
          margin: qrMargin,
          width: qrWidth,
          color: {
            dark: '#000000',
            light: '#ffffff'
          }
        }).then(() => {}).catch(err => {
          console.error('[OpticalSender] Slot render error:', err);
        });

        slotRenderPromises.push(p);
      } else {
        // Extra unused slots rendered as clean empty boxes as requested
        const emptyBox = document.createElement('div');
        emptyBox.className = 'empty-box-inner';
        emptyBox.innerHTML = `
          <div class="empty-pattern"></div>
          <span class="empty-badge">EMPTY</span>
        `;
        cellEl.appendChild(emptyBox);
        this.gridContainer.appendChild(cellEl);
      }
    }

    await Promise.all(slotRenderPromises);
  }

  public getPairingPacket(): ProtocolPacket {
    if (!this.transferId) {
      this.transferId = Math.random().toString(36).substring(2, 10);
    }
    return createPairingPacket(
      this.transferId,
      'Luma Optical Sender',
      this.gridMode,
      this.getPageSize()
    );
  }

  public async renderPairingQr(): Promise<void> {
    this.stop();
    const packet = this.getPairingPacket();
    const qrData = serializePacket(packet);

    if (this.gridContainer) {
      this.gridContainer.className = 'qr-grid-matrix grid-pairing';
      this.gridContainer.removeAttribute('style');
      this.gridContainer.innerHTML = '';

      const pairCard = document.createElement('div');
      pairCard.className = 'pairing-card-inner';
      pairCard.innerHTML = `
        <div class="pairing-badge-header">
          <span class="pairing-pulse-dot"></span>
          <span>OPTICAL DEVICE PAIRING</span>
        </div>
        <div class="pairing-canvas-wrap">
          <canvas id="pairing-canvas" class="pairing-canvas"></canvas>
        </div>
        <div class="pairing-meta">
          <span class="pairing-session font-mono">Session #${this.transferId}</span>
          <span class="pairing-mode-badge">${this.gridMode.toUpperCase()} (${this.getPageSize()} Modules)</span>
        </div>
        <p class="pairing-hint">Open Camera on Receiver and point at this QR to connect devices!</p>
      `;
      this.gridContainer.appendChild(pairCard);

      const pCanvas = pairCard.querySelector('#pairing-canvas') as HTMLCanvasElement;
      if (pCanvas) {
        await QRCode.toCanvas(pCanvas, qrData, {
          errorCorrectionLevel: 'H',
          margin: 2,
          width: 300,
          color: { dark: '#000000', light: '#ffffff' }
        });
      }
    } else if (this.canvas) {
      await QRCode.toCanvas(this.canvas, qrData, {
        errorCorrectionLevel: 'H',
        margin: 2,
        width: 340,
        color: { dark: '#000000', light: '#ffffff' }
      });
    }

    this.setState('PAIRING');
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
