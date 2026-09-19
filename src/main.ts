import confetti from 'canvas-confetti';
import { OpticalSender, SenderState, FrameInfo } from './core/sender';
import { OpticalReceiver, ReceiverState, ReconstructedFile } from './core/receiver';
import { TransferProgress, ProtocolPacket } from './core/protocol';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ================= Navigation Tabs =================
const navTabs = document.querySelectorAll<HTMLButtonElement>('.nav-tab');
const viewPanels = document.querySelectorAll<HTMLElement>('.view-panel');

function switchTab(targetTabId: string) {
  navTabs.forEach(tab => {
    const isTarget = tab.getAttribute('data-tab') === targetTabId;
    tab.classList.toggle('active', isTarget);
    tab.setAttribute('aria-selected', isTarget ? 'true' : 'false');
  });

  viewPanels.forEach(panel => {
    panel.classList.toggle('active', panel.id === targetTabId);
  });
}

navTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.getAttribute('data-tab');
    if (target) switchTab(target);
  });
});

// ================= SENDER CONTROLLER =================
const senderCanvas = document.getElementById('sender-canvas') as HTMLCanvasElement;
const qrGridContainer = document.getElementById('qr-grid-container') as HTMLDivElement;
const fileDropzone = document.getElementById('file-dropzone') as HTMLDivElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const senderFileInfo = document.getElementById('sender-file-info') as HTMLDivElement;
const senderFileName = document.getElementById('sender-file-name') as HTMLSpanElement;
const senderFileExt = document.getElementById('sender-file-ext') as HTMLSpanElement | null;
const senderFileSize = document.getElementById('sender-file-size') as HTMLSpanElement;
const senderTransferId = document.getElementById('sender-transfer-id') as HTMLSpanElement | null;
const senderFrameCount = document.getElementById('sender-frame-count') as HTMLSpanElement;
const senderTotalFramesDesc = document.getElementById('sender-total-frames-desc') as HTMLSpanElement | null;
const senderCycleTime = document.getElementById('sender-cycle-time') as HTMLSpanElement;
const senderFrameTypeBadge = document.getElementById('sender-frame-type-badge') as HTMLDivElement | null;
const senderPageBadge = document.getElementById('sender-page-badge') as HTMLSpanElement | null;
const senderSlotsIndicator = document.getElementById('sender-slots-indicator') as HTMLSpanElement | null;

const modeTabs = document.querySelectorAll<HTMLButtonElement>('.mode-tab');
const modeHintText = document.getElementById('mode-hint-text') as HTMLParagraphElement | null;
const timingLabelText = document.getElementById('timing-label-text') as HTMLSpanElement | null;
const timingSliderTicks = document.getElementById('timing-slider-ticks') as HTMLDivElement | null;
const scanInstructionText = document.getElementById('scan-instruction-text') as HTMLParagraphElement | null;

const fpsSlider = document.getElementById('sender-fps-slider') as HTMLInputElement;
const fpsLabel = document.getElementById('fps-label') as HTMLSpanElement;
const chunkSizeSelect = document.getElementById('chunk-size-select') as HTMLSelectElement;

const btnSenderStart = document.getElementById('btn-sender-start') as HTMLButtonElement;
const btnSenderPause = document.getElementById('btn-sender-pause') as HTMLButtonElement;
const btnSenderStop = document.getElementById('btn-sender-stop') as HTMLButtonElement;
const btnSenderPrev = document.getElementById('btn-sender-prev') as HTMLButtonElement;
const btnSenderNext = document.getElementById('btn-sender-next') as HTMLButtonElement;

const senderStatusDot = document.getElementById('sender-status-dot') as HTMLSpanElement;
const senderStatusText = document.getElementById('sender-status-text') as HTMLSpanElement;
const senderPlaceholder = document.getElementById('sender-placeholder') as HTMLDivElement;
const senderFrameIndicator = document.getElementById('sender-frame-indicator') as HTMLSpanElement;
const senderFramePct = document.getElementById('sender-frame-pct') as HTMLSpanElement | null;
const senderLoopCounter = document.getElementById('sender-loop-counter') as HTMLSpanElement;
const senderProgressFill = document.getElementById('sender-progress-fill') as HTMLDivElement;

// Fullscreen Elements
const qrWrapper = document.getElementById('qr-wrapper') as HTMLDivElement;
const btnFullscreenToggle = document.getElementById('btn-fullscreen-toggle') as HTMLButtonElement | null;
const btnFullscreenExit = document.getElementById('btn-fullscreen-exit') as HTMLButtonElement | null;
const fullscreenBtnText = document.getElementById('fullscreen-btn-text') as HTMLSpanElement | null;
const iconExpand = btnFullscreenToggle?.querySelector('.icon-expand') as SVGElement | null;
const iconCompress = btnFullscreenToggle?.querySelector('.icon-compress') as SVGElement | null;
const btnFsPrev = document.getElementById('btn-fs-prev') as HTMLButtonElement | null;
const btnFsPlay = document.getElementById('btn-fs-play') as HTMLButtonElement | null;
const btnFsNext = document.getElementById('btn-fs-next') as HTMLButtonElement | null;
const fsPageIndicator = document.getElementById('fs-page-indicator') as HTMLSpanElement | null;

let currentLoadedFile: File | null = null;

const sender = new OpticalSender({
  canvas: senderCanvas,
  gridContainer: qrGridContainer,
  fps: 4,
  pageHoldSeconds: 1.5,
  gridMode: '4x4',
  onStateChange: updateSenderStateUI,
  onFrameChange: updateSenderFrameUI
});

function updateSenderStateUI(state: SenderState) {
  senderStatusDot.className = 'status-dot';
  if (btnFsPlay) {
    btnFsPlay.textContent = state === 'TRANSMITTING' ? 'Pause' : 'Start Loop';
  }

  switch (state) {
    case 'IDLE':
      senderStatusDot.classList.add('dot-idle');
      senderStatusText.textContent = 'Idle';
      btnSenderStart.disabled = true;
      btnSenderPause.disabled = true;
      btnSenderStop.disabled = true;
      btnSenderPrev.disabled = true;
      btnSenderNext.disabled = true;
      senderPlaceholder.classList.remove('hidden');
      break;
    case 'LOADED':
      senderStatusDot.classList.add('dot-idle');
      senderStatusText.textContent = 'Ready';
      btnSenderStart.disabled = false;
      btnSenderPause.disabled = true;
      btnSenderStop.disabled = true;
      btnSenderPrev.disabled = false;
      btnSenderNext.disabled = false;
      senderPlaceholder.classList.add('hidden');
      break;
    case 'TRANSMITTING':
      senderStatusDot.classList.add('dot-active');
      senderStatusText.textContent = 'Transmitting Loop';
      btnSenderStart.disabled = true;
      btnSenderPause.disabled = false;
      btnSenderStop.disabled = false;
      btnSenderPrev.disabled = true;
      btnSenderNext.disabled = true;
      senderPlaceholder.classList.add('hidden');
      break;
    case 'PAUSED':
      senderStatusDot.classList.add('dot-paused');
      senderStatusText.textContent = 'Paused';
      btnSenderStart.disabled = false;
      btnSenderPause.disabled = true;
      btnSenderStop.disabled = false;
      btnSenderPrev.disabled = false;
      btnSenderNext.disabled = false;
      senderPlaceholder.classList.add('hidden');
      break;
    case 'STOPPED':
      senderStatusDot.classList.add('dot-idle');
      senderStatusText.textContent = 'Stopped';
      btnSenderStart.disabled = false;
      btnSenderPause.disabled = true;
      btnSenderStop.disabled = true;
      btnSenderPrev.disabled = false;
      btnSenderNext.disabled = false;
      senderPlaceholder.classList.add('hidden');
      break;
  }
}

function updateSenderFrameUI(info: FrameInfo) {
  if (info.totalFrames > 0) {
    const mode = info.gridMode;
    if (mode === '1x1') {
      senderFrameIndicator.textContent = `${info.frameIndex + 1} / ${info.totalFrames}`;
      if (senderSlotsIndicator) senderSlotsIndicator.textContent = `Frame ${info.frameIndex + 1}`;
      if (senderPageBadge) senderPageBadge.textContent = `Frame ${info.frameIndex + 1} / ${info.totalFrames}`;
      if (fsPageIndicator) fsPageIndicator.textContent = `Frame ${info.frameIndex + 1} / ${info.totalFrames}`;
    } else {
      senderFrameIndicator.textContent = `Page ${info.currentPage + 1} / ${info.totalPages}`;
      if (senderSlotsIndicator) {
        senderSlotsIndicator.textContent = `${info.activeSlotsCount} active, ${info.emptySlotsCount} empty`;
      }
      if (senderPageBadge) {
        senderPageBadge.textContent = `Page ${info.currentPage + 1} of ${info.totalPages}`;
      }
      if (fsPageIndicator) {
        fsPageIndicator.textContent = `Page ${info.currentPage + 1} / ${info.totalPages}`;
      }
    }

    const pct = Math.round(((info.frameIndex + 1) / info.totalFrames) * 100);
    if (senderFramePct) senderFramePct.textContent = `${pct}%`;
    senderProgressFill.style.width = `${pct}%`;
    senderLoopCounter.textContent = `${info.loopCount}`;

    if (senderFrameTypeBadge) {
      senderFrameTypeBadge.className = 'badge-frame-type';
      if (mode === '4x4') {
        senderFrameTypeBadge.classList.add('type-data');
        senderFrameTypeBadge.textContent = `⚡ 16-QR MATRIX (Page ${info.currentPage + 1}/${info.totalPages})`;
      } else if (mode === '2x2') {
        senderFrameTypeBadge.classList.add('type-data');
        senderFrameTypeBadge.textContent = `⚡ 2×2 GRID (Page ${info.currentPage + 1}/${info.totalPages})`;
      } else {
        if (info.frameType === 'TRANSFER_START') {
          senderFrameTypeBadge.classList.add('type-start');
          senderFrameTypeBadge.textContent = '🚀 TRANSFER_START (Header)';
        } else if (info.frameType === 'DATA_FRAME') {
          senderFrameTypeBadge.classList.add('type-data');
          const seq = (info.packet as any)?.seq ?? Math.max(0, info.frameIndex - 1);
          const dataCount = Math.max(1, info.totalFrames - 2);
          senderFrameTypeBadge.textContent = `📦 DATA_FRAME (Chunk ${seq + 1}/${dataCount})`;
        } else if (info.frameType === 'TRANSFER_END') {
          senderFrameTypeBadge.classList.add('type-end');
          senderFrameTypeBadge.textContent = '🏁 TRANSFER_END (Verify)';
        } else {
          senderFrameTypeBadge.classList.add('type-idle');
          senderFrameTypeBadge.textContent = 'Ready';
        }
      }
    }
  } else {
    senderFrameIndicator.textContent = '0 / 0';
    if (senderSlotsIndicator) senderSlotsIndicator.textContent = '-';
    if (senderPageBadge) senderPageBadge.textContent = 'Page 0 / 0';
    if (senderFramePct) senderFramePct.textContent = '0%';
    senderProgressFill.style.width = '0%';
    senderLoopCounter.textContent = '0';
    if (senderFrameTypeBadge) {
      senderFrameTypeBadge.className = 'badge-frame-type type-idle';
      senderFrameTypeBadge.textContent = 'Waiting for file...';
    }
  }
}

const senderAlert = document.getElementById('sender-alert') as HTMLDivElement | null;
const btnSenderSampleTxt = document.getElementById('btn-sender-sample-txt') as HTMLButtonElement | null;
const btnSenderSampleImg = document.getElementById('btn-sender-sample-img') as HTMLButtonElement | null;

function showSenderAlert(message: string, type: 'info' | 'warning' | 'error' = 'info') {
  if (!senderAlert) return;
  senderAlert.className = `alert-box alert-${type}`;
  senderAlert.textContent = message;
  senderAlert.classList.remove('hidden');
}

function clearSenderAlert() {
  if (!senderAlert) return;
  senderAlert.classList.add('hidden');
  senderAlert.textContent = '';
}

async function handleFileSelected(file: File) {
  clearSenderAlert();
  try {
    currentLoadedFile = file;
    senderFileInfo.classList.remove('hidden');
    senderFileName.textContent = file.name;
    senderFileSize.textContent = formatBytes(file.size);

    const ext = file.name.split('.').pop()?.toUpperCase() || 'BIN';
    if (senderFileExt) senderFileExt.textContent = ext;

    if (file.size > 2 * 1024 * 1024) {
      showSenderAlert(`Notice: Large file (${formatBytes(file.size)}). Optical transfer works best with smaller files (< 1MB).`, 'warning');
    }

    const chunkSize = parseInt(chunkSizeSelect.value, 10);
    await sender.loadFile(file, chunkSize);

    const info = sender.getFrameInfo();
    const dataChunks = Math.max(1, info.totalFrames - 2);
    senderFrameCount.textContent = `${dataChunks} data chunks (${chunkSize}B/chunk)`;
    if (senderTransferId) senderTransferId.textContent = `#${info.transferId}`;
    if (senderTotalFramesDesc) {
      senderTotalFramesDesc.textContent = `${info.totalFrames} frames [1 START + ${dataChunks} DATA + 1 END]`;
    }

    if (info.gridMode === '1x1') {
      const estSeconds = (info.totalFrames / sender.getFps()).toFixed(1);
      senderCycleTime.textContent = `~${estSeconds}s / cycle`;
    } else {
      const estSeconds = (info.totalPages * sender.getPageHoldSeconds()).toFixed(1);
      senderCycleTime.textContent = `~${estSeconds}s / cycle (${info.totalPages} page${info.totalPages > 1 ? 's' : ''})`;
    }
  } catch (err: any) {
    console.error('Failed to load file:', err);
    showSenderAlert(`Error loading file: ${err.message || err}`, 'error');
  }
}

// Optical Transmission Mode Tabs
function updateTimingControlsForMode(mode: '1x1' | '2x2' | '4x4') {
  if (mode === '1x1') {
    if (timingLabelText) timingLabelText.textContent = 'Transmission Speed:';
    fpsLabel.textContent = `${sender.getFps()} FPS`;
    fpsSlider.min = '1';
    fpsSlider.max = '15';
    fpsSlider.step = '1';
    fpsSlider.value = `${sender.getFps()}`;
    if (timingSliderTicks) {
      timingSliderTicks.innerHTML = `
        <span>1 (Slow/Stable)</span>
        <span>4 (Balanced)</span>
        <span>15 (Turbo)</span>
      `;
    }
    if (modeHintText) {
      modeHintText.textContent = 'Sequential single QR flashing at high speed. Up to 15 FPS.';
    }
    if (scanInstructionText) {
      scanInstructionText.textContent = 'Point the receiving device at the screen. Single QR flashes continuously.';
    }
  } else {
    if (timingLabelText) timingLabelText.textContent = 'Page Hold Duration:';
    fpsLabel.textContent = `${sender.getPageHoldSeconds().toFixed(1)}s / page`;
    fpsSlider.min = '5';
    fpsSlider.max = '35';
    fpsSlider.step = '1';
    fpsSlider.value = `${Math.round(sender.getPageHoldSeconds() * 10)}`;
    if (timingSliderTicks) {
      timingSliderTicks.innerHTML = `
        <span>0.5s (Fast)</span>
        <span>1.5s (Optimal)</span>
        <span>3.5s (Steady)</span>
      `;
    }
    if (modeHintText) {
      modeHintText.textContent = mode === '4x4'
        ? 'Displays 16 QR codes in a square. Mobile scans all 16 at once; extra boxes stay empty!'
        : 'Displays 4 QR codes in a 2×2 grid for smaller screens or mid-range phone cameras.';
    }
    if (scanInstructionText) {
      scanInstructionText.textContent = mode === '4x4'
        ? 'Point the receiving phone camera at the 16-QR matrix. Mobile scans all 16 codes at once. Extra boxes stay empty.'
        : 'Point camera at the 2×2 grid to capture 4 chunks simultaneously.';
    }
  }
  const info = sender.getFrameInfo();
  if (info.totalFrames > 0) {
    if (mode === '1x1') {
      senderCycleTime.textContent = `~${(info.totalFrames / sender.getFps()).toFixed(1)}s / cycle`;
    } else {
      senderCycleTime.textContent = `~${(info.totalPages * sender.getPageHoldSeconds()).toFixed(1)}s / cycle (${info.totalPages} pages)`;
    }
  }
}

modeTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const mode = tab.getAttribute('data-mode') as '1x1' | '2x2' | '4x4';
    if (!mode) return;
    modeTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    sender.setGridMode(mode);
    updateTimingControlsForMode(mode);
  });
});

// Window-level drag protection to prevent opening dropped files as browser URLs
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// File input change event (triggered natively when user clicks the dropzone label or browse button)
fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files[0]) {
    handleFileSelected(fileInput.files[0]);
    // Reset input value so selecting the same file triggers change event reliably
    fileInput.value = '';
  }
});

fileDropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  fileDropzone.classList.add('dragover');
});

fileDropzone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  e.stopPropagation();
  fileDropzone.classList.remove('dragover');
});

fileDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  fileDropzone.classList.remove('dragover');
  if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
    handleFileSelected(e.dataTransfer.files[0]);
  }
});

// Quick Sample File Buttons
if (btnSenderSampleTxt) {
  btnSenderSampleTxt.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const content = `Luma Air-Gapped Optical File Transfer Protocol v1\nTimestamp: ${new Date().toLocaleString()}\n` +
      'Rapidly flashing QR frames stream binary data directly between screens and cameras without Wi-Fi or cloud.\n'.repeat(4);
    const blob = new Blob([content], { type: 'text/plain' });
    const file = new File([blob], 'sample_memo.txt', { type: 'text/plain' });
    handleFileSelected(file);
  });
}

if (btnSenderSampleImg) {
  btnSenderSampleImg.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 64, 64);
    grad.addColorStop(0, '#0284c7');
    grad.addColorStop(1, '#38bdf8');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('OPTICAL', 32, 28);
    ctx.fillText('DROP', 32, 42);
    canvas.toBlob((blob) => {
      if (blob) {
        const file = new File([blob], 'sample_badge.png', { type: 'image/png' });
        handleFileSelected(file);
      }
    }, 'image/png');
  });
}

// Sender Controls
btnSenderStart.addEventListener('click', () => sender.start());
btnSenderPause.addEventListener('click', () => sender.pause());
btnSenderStop.addEventListener('click', () => sender.stop());
btnSenderPrev.addEventListener('click', () => sender.prevFrame());
btnSenderNext.addEventListener('click', () => sender.nextFrame());

fpsSlider.addEventListener('input', () => {
  const mode = sender.getGridMode();
  if (mode === '1x1') {
    const fps = parseInt(fpsSlider.value, 10);
    fpsLabel.textContent = `${fps} FPS`;
    sender.setFps(fps);
  } else {
    const sec = parseInt(fpsSlider.value, 10) / 10;
    fpsLabel.textContent = `${sec.toFixed(1)}s / page`;
    sender.setPageHoldSeconds(sec);
  }
  const info = sender.getFrameInfo();
  if (info.totalFrames > 0) {
    if (mode === '1x1') {
      senderCycleTime.textContent = `~${(info.totalFrames / sender.getFps()).toFixed(1)}s / cycle`;
    } else {
      senderCycleTime.textContent = `~${(info.totalPages * sender.getPageHoldSeconds()).toFixed(1)}s / cycle (${info.totalPages} pages)`;
    }
  }
});

chunkSizeSelect.addEventListener('change', () => {
  if (currentLoadedFile) {
    handleFileSelected(currentLoadedFile);
  }
});

// ================= FULLSCREEN OPTICAL DISPLAY CONTROLLER =================
function isCurrentlyFullscreen(): boolean {
  return !!(
    document.fullscreenElement ||
    (document as any).webkitFullscreenElement ||
    qrWrapper.classList.contains('is-fullscreen-fallback')
  );
}

async function enterFullscreen() {
  try {
    if (qrWrapper.requestFullscreen) {
      await qrWrapper.requestFullscreen();
    } else if ((qrWrapper as any).webkitRequestFullscreen) {
      await (qrWrapper as any).webkitRequestFullscreen();
    } else {
      qrWrapper.classList.add('is-fullscreen-fallback');
    }
  } catch {
    qrWrapper.classList.add('is-fullscreen-fallback');
  }
  updateFullscreenUI(true);
}

async function exitFullscreen() {
  qrWrapper.classList.remove('is-fullscreen-fallback');
  try {
    if (document.fullscreenElement || (document as any).webkitFullscreenElement) {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        await (document as any).webkitExitFullscreen();
      }
    }
  } catch {}
  updateFullscreenUI(false);
}

function updateFullscreenUI(inFullscreen: boolean) {
  if (fullscreenBtnText) {
    fullscreenBtnText.textContent = inFullscreen ? 'Exit Full Screen' : 'Full Screen';
  }
  if (iconExpand && iconCompress) {
    iconExpand.classList.toggle('hidden', inFullscreen);
    iconCompress.classList.toggle('hidden', !inFullscreen);
  }
  if (btnFullscreenExit) {
    btnFullscreenExit.classList.toggle('hidden', !inFullscreen);
  }
  const fsBar = document.getElementById('fullscreen-controls-bar');
  if (fsBar) {
    fsBar.classList.toggle('hidden', !inFullscreen);
  }
}

if (btnFullscreenToggle) {
  btnFullscreenToggle.addEventListener('click', () => {
    if (isCurrentlyFullscreen()) {
      exitFullscreen();
    } else {
      enterFullscreen();
    }
  });
}

if (btnFullscreenExit) {
  btnFullscreenExit.addEventListener('click', () => {
    exitFullscreen();
  });
}

document.addEventListener('fullscreenchange', () => {
  updateFullscreenUI(!!document.fullscreenElement);
});
document.addEventListener('webkitfullscreenchange', () => {
  updateFullscreenUI(!!(document as any).webkitFullscreenElement);
});

// ESC and 'F' key shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && qrWrapper.classList.contains('is-fullscreen-fallback')) {
    exitFullscreen();
  }
  if ((e.key === 'f' || e.key === 'F') && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) {
    if (isCurrentlyFullscreen()) exitFullscreen();
    else enterFullscreen();
  }
});

// Fullscreen in-overlay navigation buttons
if (btnFsPrev) {
  btnFsPrev.addEventListener('click', () => sender.prevFrame());
}
if (btnFsNext) {
  btnFsNext.addEventListener('click', () => sender.nextFrame());
}
if (btnFsPlay) {
  btnFsPlay.addEventListener('click', () => {
    if (sender.getState() === 'TRANSMITTING') {
      sender.pause();
    } else {
      sender.start();
    }
  });
}

// ================= RECEIVER CONTROLLER =================
const receiverVideo = document.getElementById('receiver-video') as HTMLVideoElement;
const btnCameraToggle = document.getElementById('btn-camera-toggle') as HTMLButtonElement;
const cameraBtnText = document.getElementById('camera-btn-text') as HTMLSpanElement;
const btnCameraFlip = document.getElementById('btn-camera-flip') as HTMLButtonElement;
const cameraSelect = document.getElementById('camera-select') as HTMLSelectElement;
const cameraPlaceholder = document.getElementById('camera-placeholder') as HTMLDivElement;
const viewfinderOverlay = document.getElementById('viewfinder-overlay') as HTMLDivElement;
const recBatchBadge = document.getElementById('rec-batch-badge') as HTMLDivElement | null;
const recMultiIngestion = document.getElementById('rec-multi-ingestion') as HTMLSpanElement | null;

const receiverStatusDot = document.getElementById('receiver-status-dot') as HTMLSpanElement;
const receiverStatusText = document.getElementById('receiver-status-text') as HTMLSpanElement;
const btnReceiverReset = document.getElementById('btn-receiver-reset') as HTMLButtonElement;

const recSessionId = document.getElementById('rec-session-id') as HTMLSpanElement | null;
const recProtocolStatus = document.getElementById('rec-protocol-status') as HTMLSpanElement | null;
const recRejectedAlert = document.getElementById('rec-rejected-alert') as HTMLDivElement | null;
const recFileName = document.getElementById('rec-file-name') as HTMLSpanElement;
const recFileSize = document.getElementById('rec-file-size') as HTMLSpanElement;
const recChunkCount = document.getElementById('rec-chunk-count') as HTMLSpanElement;
const recMissingChunks = document.getElementById('rec-missing-chunks') as HTMLSpanElement;
const recProgressFill = document.getElementById('rec-progress-fill') as HTMLDivElement;
const chunkGrid = document.getElementById('chunk-grid') as HTMLDivElement;
const matrixStatus = document.getElementById('matrix-status') as HTMLSpanElement;

const reconstructedCard = document.getElementById('reconstructed-card') as HTMLDivElement;
const filePreviewArea = document.getElementById('file-preview-area') as HTMLDivElement;
const btnDownloadFile = document.getElementById('btn-download-file') as HTMLButtonElement;
const downloadSizeBadge = document.getElementById('download-size-badge') as HTMLSpanElement;
const btnReceiveAnother = document.getElementById('btn-receive-another') as HTMLButtonElement;

let isCameraActive = false;
let currentFacingMode: 'environment' | 'user' = 'environment';
let availableCameras: MediaDeviceInfo[] = [];
let batchBadgeTimeout: number | null = null;

const receiver = new OpticalReceiver({
  onStateChange: (state: ReceiverState, detail?: string) => {
    receiverStatusDot.className = 'status-dot';
    switch (state) {
      case 'IDLE':
        receiverStatusDot.classList.add('dot-idle');
        receiverStatusText.textContent = 'Camera Off';
        break;
      case 'STARTING':
        receiverStatusDot.classList.add('dot-paused');
        receiverStatusText.textContent = 'Starting Camera...';
        break;
      case 'SCANNING':
        receiverStatusDot.classList.add('dot-active');
        receiverStatusText.textContent = 'Scanning for QR Frames...';
        break;
      case 'RECEIVING':
        receiverStatusDot.classList.add('dot-active');
        receiverStatusText.textContent = 'Capturing Stream';
        break;
      case 'COMPLETE':
        receiverStatusDot.classList.add('dot-active');
        receiverStatusText.textContent = 'Transfer Complete!';
        break;
      case 'ERROR':
        receiverStatusDot.classList.add('dot-error');
        receiverStatusText.textContent = detail || 'Error';
        break;
    }
  },
  onProgress: (progress: TransferProgress, latestPacket: ProtocolPacket | null) => {
    updateReceiverDashboard(progress, latestPacket);
  },
  onFrameRejected: (_packet: ProtocolPacket, reason: string) => {
    if (recRejectedAlert) {
      recRejectedAlert.classList.remove('hidden');
      recRejectedAlert.textContent = `⚠️ Frame Rejected: ${reason}`;
    }
  },
  onBatchScanned: (acceptedInFrame: number, totalFoundInFrame: number) => {
    if (recMultiIngestion) {
      recMultiIngestion.textContent = `⚡ +${acceptedInFrame} chunks ingested (${totalFoundInFrame} visible)`;
    }
    if (recBatchBadge && totalFoundInFrame > 1) {
      recBatchBadge.textContent = `⚡ +${totalFoundInFrame} QRs Scanned at Once!`;
      recBatchBadge.classList.remove('hidden');
      if (batchBadgeTimeout !== null) clearTimeout(batchBadgeTimeout);
      batchBadgeTimeout = window.setTimeout(() => {
        recBatchBadge.classList.add('hidden');
      }, 1400);
    }
  },
  onFileComplete: (reconstructed: ReconstructedFile) => {
    displayReconstructedFile(reconstructed);
  },
  onError: (err) => {
    alert(`Camera error: ${err.message}`);
  }
});

function updateReceiverDashboard(progress: TransferProgress, _latestPacket: ProtocolPacket | null) {
  if (recSessionId) {
    recSessionId.textContent = progress.transferId ? `#${progress.transferId} (Locked)` : 'Unlocked (Awaiting Stream)';
  }

  if (recProtocolStatus) {
    if (progress.isComplete) {
      recProtocolStatus.textContent = 'Verified & Complete ✓';
      recProtocolStatus.className = 'info-value font-mono text-success';
    } else if (progress.hasStartHeader && progress.hasEndMarker) {
      recProtocolStatus.textContent = 'Header & End verified, catching chunks...';
      recProtocolStatus.className = 'info-value font-mono text-cyan';
    } else if (progress.hasStartHeader) {
      recProtocolStatus.textContent = 'Header locked, receiving data frames...';
      recProtocolStatus.className = 'info-value font-mono text-cyan';
    } else {
      recProtocolStatus.textContent = 'Capturing chunks, awaiting header...';
      recProtocolStatus.className = 'info-value font-mono text-warning';
    }
  }

  if (progress.rejectedCount > 0 && recRejectedAlert) {
    recRejectedAlert.classList.remove('hidden');
    recRejectedAlert.textContent = `⚠️ Rejected ${progress.rejectedCount} foreign frame(s) from different transfer (#${progress.lastRejectedTransferId})`;
  }

  if (progress.totalChunks > 0) {
    recFileName.textContent = progress.fileName;
    recFileSize.textContent = formatBytes(progress.fileSize);
    recChunkCount.textContent = `${progress.receivedCount} / ${progress.totalChunks} (${progress.percentage}%)`;
    recProgressFill.style.width = `${progress.percentage}%`;

    if (progress.missingChunks.length > 0) {
      if (progress.missingChunks.length <= 10) {
        recMissingChunks.textContent = progress.missingChunks.map(i => `#${i + 1}`).join(', ');
      } else {
        recMissingChunks.textContent = `${progress.missingChunks.length} frames remaining`;
      }
      recMissingChunks.className = 'info-value font-mono text-warning';
    } else {
      recMissingChunks.textContent = 'All frames received!';
      recMissingChunks.className = 'info-value font-mono text-success';
    }

    matrixStatus.textContent = `${progress.receivedCount}/${progress.totalChunks} frames`;

    // Render / update chunk matrix
    if (chunkGrid.children.length !== progress.totalChunks) {
      chunkGrid.innerHTML = '';
      for (let i = 0; i < progress.totalChunks; i++) {
        const cell = document.createElement('div');
        cell.className = 'chunk-cell';
        cell.id = `chunk-cell-${i}`;
        cell.textContent = `${i + 1}`;
        chunkGrid.appendChild(cell);
      }
    }

    for (let i = 0; i < progress.totalChunks; i++) {
      const cell = document.getElementById(`chunk-cell-${i}`);
      if (cell) {
        const isReceived = progress.receivedIndices.includes(i);
        cell.classList.toggle('received', isReceived);
      }
    }
  } else {
    recFileName.textContent = 'Waiting for sender...';
    recFileSize.textContent = '-';
    recChunkCount.textContent = '0 / 0 (0%)';
    recMissingChunks.textContent = 'None';
    recProgressFill.style.width = '0%';
    matrixStatus.textContent = 'Waiting for stream';
    chunkGrid.innerHTML = '';
  }
}

function displayReconstructedFile(file: ReconstructedFile) {
  reconstructedCard.classList.remove('hidden');
  downloadSizeBadge.textContent = formatBytes(file.fileSize);

  // Confetti celebration!
  confetti({
    particleCount: 80,
    spread: 70,
    origin: { y: 0.6 }
  });

  // Preview
  filePreviewArea.innerHTML = '';
  if (file.isImage) {
    filePreviewArea.classList.remove('hidden');
    const img = document.createElement('img');
    img.src = file.downloadUrl;
    img.alt = file.fileName;
    filePreviewArea.appendChild(img);
  } else if (file.textPreview) {
    filePreviewArea.classList.remove('hidden');
    const pre = document.createElement('pre');
    pre.textContent = file.textPreview;
    filePreviewArea.appendChild(pre);
  } else {
    filePreviewArea.classList.add('hidden');
  }
}

btnDownloadFile.addEventListener('click', () => {
  receiver.downloadFile();
});

btnReceiveAnother.addEventListener('click', () => {
  receiver.resetTransfer();
  reconstructedCard.classList.add('hidden');
  filePreviewArea.classList.add('hidden');
});

btnReceiverReset.addEventListener('click', () => {
  receiver.resetTransfer();
  reconstructedCard.classList.add('hidden');
  filePreviewArea.classList.add('hidden');
});

// Camera controls
async function startCameraSession() {
  try {
    const selectedDeviceId = cameraSelect.value || undefined;
    await receiver.startCamera(receiverVideo, selectedDeviceId, currentFacingMode);
    isCameraActive = true;
    cameraBtnText.textContent = 'Stop Camera';
    cameraPlaceholder.classList.add('hidden');
    viewfinderOverlay.classList.remove('hidden');
    btnCameraFlip.disabled = false;
    cameraSelect.disabled = false;

    // Populate camera devices
    availableCameras = await receiver.getAvailableCameras();
    if (availableCameras.length > 0 && cameraSelect.options.length <= 1) {
      cameraSelect.innerHTML = '';
      availableCameras.forEach((cam, idx) => {
        const opt = document.createElement('option');
        opt.value = cam.deviceId;
        opt.textContent = cam.label || `Camera ${idx + 1}`;
        cameraSelect.appendChild(opt);
      });
    }
  } catch (err: any) {
    console.error('Failed to start camera', err);
  }
}

function stopCameraSession() {
  receiver.stop();
  isCameraActive = false;
  cameraBtnText.textContent = 'Start Camera';
  cameraPlaceholder.classList.remove('hidden');
  btnCameraFlip.disabled = true;
  cameraSelect.disabled = true;
}

btnCameraToggle.addEventListener('click', () => {
  if (isCameraActive) {
    stopCameraSession();
  } else {
    startCameraSession();
  }
});

btnCameraFlip.addEventListener('click', async () => {
  currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
  if (isCameraActive) {
    stopCameraSession();
    await startCameraSession();
  }
});

cameraSelect.addEventListener('change', async () => {
  if (isCameraActive) {
    stopCameraSession();
    await startCameraSession();
  }
});

// ================= SELF-TEST SANDBOX CONTROLLER =================
const sandboxSenderCanvas = document.getElementById('sandbox-sender-canvas') as HTMLCanvasElement;
const sandboxFrameIdx = document.getElementById('sandbox-frame-idx') as HTMLSpanElement;
const btnSandboxPlay = document.getElementById('btn-sandbox-play') as HTMLButtonElement;
const btnSandboxPause = document.getElementById('btn-sandbox-pause') as HTMLButtonElement;
const btnSandboxStop = document.getElementById('btn-sandbox-stop') as HTMLButtonElement;
const btnSampleTxt = document.getElementById('btn-sandbox-sample-txt') as HTMLButtonElement;
const btnSampleImg = document.getElementById('btn-sandbox-sample-img') as HTMLButtonElement;

const sandboxRecStatus = document.getElementById('sandbox-rec-status') as HTMLSpanElement;
const sandboxRecProgress = document.getElementById('sandbox-rec-progress') as HTMLSpanElement;
const sandboxProgressFill = document.getElementById('sandbox-progress-fill') as HTMLDivElement;
const sandboxChunkGrid = document.getElementById('sandbox-chunk-grid') as HTMLDivElement;
const sandboxSuccessBox = document.getElementById('sandbox-success-box') as HTMLDivElement;
const btnSandboxDownload = document.getElementById('btn-sandbox-download') as HTMLButtonElement;

const sandboxSender = new OpticalSender({
  canvas: sandboxSenderCanvas,
  fps: 5,
  onFrameChange: (info) => {
    sandboxFrameIdx.textContent = info.totalFrames > 0 ? `${info.frameIndex + 1}/${info.totalFrames}` : '0/0';
  }
});

const sandboxReceiver = new OpticalReceiver({
  onStateChange: (state) => {
    sandboxRecStatus.textContent = state;
  },
  onProgress: (progress) => {
    if (progress.totalChunks > 0) {
      sandboxRecProgress.textContent = `${progress.receivedCount} / ${progress.totalChunks} (${progress.percentage}%)`;
      sandboxProgressFill.style.width = `${progress.percentage}%`;

      if (sandboxChunkGrid.children.length !== progress.totalChunks) {
        sandboxChunkGrid.innerHTML = '';
        for (let i = 0; i < progress.totalChunks; i++) {
          const cell = document.createElement('div');
          cell.className = 'chunk-cell';
          cell.id = `sb-chunk-cell-${i}`;
          cell.textContent = `${i + 1}`;
          sandboxChunkGrid.appendChild(cell);
        }
      }

      for (let i = 0; i < progress.totalChunks; i++) {
        const cell = document.getElementById(`sb-chunk-cell-${i}`);
        if (cell) {
          cell.classList.toggle('received', progress.receivedIndices.includes(i));
        }
      }
    }
  },
  onFileComplete: () => {
    sandboxSuccessBox.classList.remove('hidden');
    confetti({
      particleCount: 50,
      spread: 60,
      origin: { y: 0.7 }
    });
  }
});

async function loadSandboxSampleText() {
  const sampleContent = `Luma Optical File Transfer Protocol v1\n\nTransfer Mode: Optical Air-Gapped Simplex\nPayload: Cross-device screen-to-camera frame streaming\nCRC32 Verification: Enabled\nTimestamp: ${new Date().toISOString()}\n` +
    'The quick brown fox jumps over the lazy dog. 1234567890.\n'.repeat(6);
  const blob = new Blob([sampleContent], { type: 'text/plain' });
  const file = new File([blob], 'optical_sample.txt', { type: 'text/plain' });
  await sandboxSender.loadFile(file, 160);
  sandboxReceiver.resetTransfer();
  sandboxSuccessBox.classList.add('hidden');
}

async function loadSandboxSampleImage() {
  // Generate a small colorful 64x64 PNG in memory
  const offscreen = document.createElement('canvas');
  offscreen.width = 64;
  offscreen.height = 64;
  const ctx = offscreen.getContext('2d')!;
  
  const grad = ctx.createLinearGradient(0, 0, 64, 64);
  grad.addColorStop(0, '#38bdf8');
  grad.addColorStop(0.5, '#ec4899');
  grad.addColorStop(1, '#eab308');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('OPTICAL', 32, 28);
  ctx.fillText('DROP', 32, 42);

  offscreen.toBlob(async (blob) => {
    if (blob) {
      const file = new File([blob], 'optical_badge.png', { type: 'image/png' });
      await sandboxSender.loadFile(file, 200);
      sandboxReceiver.resetTransfer();
      sandboxSuccessBox.classList.add('hidden');
    }
  }, 'image/png');
}

btnSampleTxt.addEventListener('click', loadSandboxSampleText);
btnSampleImg.addEventListener('click', loadSandboxSampleImage);

btnSandboxPlay.addEventListener('click', () => {
  sandboxSender.start();
  sandboxReceiver.startCanvasScan(sandboxSenderCanvas);
});

btnSandboxPause.addEventListener('click', () => {
  sandboxSender.pause();
});

btnSandboxStop.addEventListener('click', () => {
  sandboxSender.stop();
  sandboxReceiver.stop();
  sandboxReceiver.resetTransfer();
  sandboxSuccessBox.classList.add('hidden');
  sandboxProgressFill.style.width = '0%';
  sandboxRecProgress.textContent = '0 / 0 (0%)';
  sandboxChunkGrid.innerHTML = '';
});

btnSandboxDownload.addEventListener('click', () => {
  sandboxReceiver.downloadFile();
});

// Load default sample in sandbox on startup
loadSandboxSampleText();
