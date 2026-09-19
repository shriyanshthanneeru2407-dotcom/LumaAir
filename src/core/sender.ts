import QRCode from 'qrcode';
import {
  createTransferPackets,
  createSingleStaticPacket,
  serializePacket,
  ProtocolPacket,
  PacketType,
  DEFAULT_CHUNK_SIZE
} from './protocol';

export type SenderState = 'IDLE' | 'LOADED' | 'TRANSMITTING' | 'PAUSED' | 'STOPPED';
export type GridMode = '1x1' | '2x2' | '4x4' | '6x6';

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
  isStaticMode: boolean;
  isStaticEligible: boolean;
}

export class OpticalSender {
  private file: File | null = null;
  private packets: ProtocolPacket[] = [];
  private currentFrameIndex: number = 0;
  private loopCount: number = 0;
  private state: SenderState = 'IDLE';
  private fps: number = 4; // FPS for 1x1 mode
  private pageHoldSeconds: number = 1.5; // Seconds per page for 2x2 & 4x4
  private timerId: number | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private gridContainer: HTMLElement | null = null;
  private transferId: string = '';
  private gridMode: GridMode = '1x1'; // Default to Giant Single QR code
  private autoStaticMode: boolean = true;
  private chunkSize: number = DEFAULT_CHUNK_SIZE;

  private onStateChangeCb?: (state: SenderState) => void;
  private onFrameChangeCb?: (info: FrameInfo) => void;

  constructor(options?: {
    canvas?: HTMLCanvasElement;
    gridContainer?: HTMLElement;
    fps?: number;
    pageHoldSeconds?: number;
    gridMode?: GridMode;
    autoStaticMode?: boolean;
    onStateChange?: (state: SenderState) => void;
    onFrameChange?: (info: FrameInfo) => void;
  }) {
    if (options?.canvas) this.canvas = options.canvas;
    if (options?.gridContainer) this.gridContainer = options.gridContainer;
    if (options?.fps) this.fps = options.fps;
    if (options?.pageHoldSeconds) this.pageHoldSeconds = options.pageHoldSeconds;
    if (options?.gridMode) this.gridMode = options.gridMode;
    if (options?.autoStaticMode !== undefined) this.autoStaticMode = options.autoStaticMode;
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

  public async loadFile(file: File, chunkSize: number = DEFAULT_CHUNK_SIZE, forceStream: boolean = false): Promise<void> {
    this.stop();
    this.file = file;
    this.chunkSize = chunkSize;
    this.currentFrameIndex = 0;
    this.loopCount = 0;

    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    if (this.autoStaticMode && this.gridMode === '1x1' && !forceStream && uint8.byteLength <= 2400) {
      this.packets = [createSingleStaticPacket(uint8, file.name, file.type || 'application/octet-stream')];
    } else {
      this.packets = createTransferPackets(uint8, file.name, file.type || 'application/octet-stream', chunkSize);
    }
    this.transferId = this.packets.length > 0 ? this.packets[0].transfer_id : '';
    this.setState('LOADED');
    await this.renderCurrentFrame();
  }

  public isStaticEligible(): boolean {
    return this.file !== null && this.file.size <= 2400;
  }

  public isStaticMode(): boolean {
    return this.packets.length === 1 && this.packets[0].type === 'STATIC_FILE';
  }

  public async setUseStaticMode(useStatic: boolean): Promise<void> {
    if (!this.file) return;
    await this.loadFile(this.file, this.chunkSize, !useStatic);
  }

  public start() {
    if (this.packets.length === 0) return;
    if (this.state === 'TRANSMITTING') return;

    this.setState('TRANSMITTING');
    if (!this.isStaticMode()) {
      this.startLoop();
    }
  }

  public pause() {
    if (this.state !== 'TRANSMITTING') return;
    this.stopLoop();
    this.setState('PAUSED');
  }

  public getPageSize(): number {
    if (this.gridMode === '6x6') return 36;
    if (this.gridMode === '4x4') return 16;
    if (this.gridMode === '2x2') return 4;
    return 1;
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
      frameType: curPacket?.type || 'TRANSFER_START',
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
      emptySlotsCount: emptySlots,
      isStaticMode: curPacket?.type === 'STATIC_FILE',
      isStaticEligible: (this.file?.size || 0) <= 2400
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
    this.gridContainer.innerHTML = '';

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
        } else if (packet.type === 'STATIC_FILE') {
          badge.textContent = 'STATIC (1-SHOT)';
          badge.classList.add('badge-start');
        } else {
          badge.textContent = `#${(packet as any).seq + 1}`;
          badge.classList.add('badge-data');
        }

        cellEl.appendChild(canvas);
        cellEl.appendChild(badge);
        this.gridContainer.appendChild(cellEl);

        const qrWidth = this.gridMode === '6x6' ? 96 : (this.gridMode === '4x4' ? 140 : (this.gridMode === '2x2' ? 200 : 360));
        const qrMargin = (this.gridMode === '6x6' || this.gridMode === '4x4') ? 1 : 2;

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
