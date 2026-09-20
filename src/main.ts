import confetti from 'canvas-confetti';
import { OpticalSender, SenderState, FrameInfo } from './core/sender';
import { OpticalReceiver, ReceiverState, ReconstructedFile } from './core/receiver';
import { FrameHeader, DEFAULT_FRAME_BYTES } from './core/protocol';
import { ReceiverProgress } from './core/receiver';

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
const qrGridMatrix = document.getElementById('qr-grid-matrix') as HTMLDivElement;
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
const btnSenderPair = document.getElementById('btn-sender-pair') as HTMLButtonElement | null;

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
const senderPctIndicator = document.getElementById('sender-pct-indicator') as HTMLSpanElement | null;
const senderLoopCounter = document.getElementById('sender-loop-counter') as HTMLSpanElement;
const senderProgressFill = document.getElementById('sender-progress-fill') as HTMLDivElement;

// Fullscreen Elements
const qrWrapper = document.getElementById('qr-wrapper') as HTMLDivElement;
const btnFullscreenToggle = document.getElementById('btn-fullscreen-toggle') as HTMLButtonElement | null;
const btnFullscreenExit = document.getElementById('btn-fullscreen-exit') as HTMLButtonElement | null;
const fullscreenBtnText = document.getElementById('fullscreen-btn-text') as HTMLSpanElement | null;
const iconExpand = btnFullscreenToggle?.querySelector('.icon-expand') as SVGElement | null;
const iconCompress = btnFullscreenToggle?.querySelector('.icon-compress') as SVGElement | null;
const btnFsStart = document.getElementById('btn-fs-start') as HTMLButtonElement | null;
const btnFsPause = document.getElementById('btn-fs-pause') as HTMLButtonElement | null;
const btnFsStop = document.getElementById('btn-fs-stop') as HTMLButtonElement | null;
const btnFsPrev = document.getElementById('btn-fs-prev') as HTMLButtonElement | null;
const btnFsNext = document.getElementById('btn-fs-next') as HTMLButtonElement | null;
const fsPageIndicator = document.getElementById('fs-page-indicator') as HTMLSpanElement | null;

let currentLoadedFile: File | null = null;

const sender = new OpticalSender({
  fps: 60,
  frameBytes: DEFAULT_FRAME_BYTES,
  onStateChange: updateSenderStateUI,
  onFrameChange: updateSenderFrameUI
});

// Attach single QR container
sender.attachGridContainer(qrGridMatrix);

function updateSenderStateUI(state: SenderState) {
  senderStatusDot.className = 'status-dot';

  // Sync fullscreen 5 controls with sender state
  const syncFsButtons = (start: boolean, pause: boolean, stop: boolean, prev: boolean, next: boolean) => {
    if (btnFsStart) btnFsStart.disabled = start;
    if (btnFsPause) btnFsPause.disabled = pause;
    if (btnFsStop) btnFsStop.disabled = stop;
    if (btnFsPrev) btnFsPrev.disabled = prev;
    if (btnFsNext) btnFsNext.disabled = next;
  };

  switch (state) {
    case 'PAIRING':
      senderStatusDot.classList.add('dot-active');
      senderStatusText.textContent = 'Pairing Mode';
      btnSenderStart.disabled = true;
      btnSenderPause.disabled = true;
      btnSenderStop.disabled = false;
      btnSenderPrev.disabled = true;
      btnSenderNext.disabled = true;
      syncFsButtons(true, true, false, true, true);
      senderPlaceholder.classList.add('hidden');
      qrGridMatrix.classList.remove('hidden');
      break;

    case 'IDLE':
      senderStatusDot.classList.add('dot-idle');
      senderStatusText.textContent = 'Idle';
      btnSenderStart.disabled = true;
      btnSenderPause.disabled = true;
      btnSenderStop.disabled = true;
      btnSenderPrev.disabled = true;
      btnSenderNext.disabled = true;
      syncFsButtons(true, true, true, true, true);
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
      syncFsButtons(false, true, true, false, false);
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
      syncFsButtons(true, false, false, true, true);
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
      syncFsButtons(false, true, false, false, false);
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
      syncFsButtons(false, true, true, false, false);
      senderPlaceholder.classList.add('hidden');
      break;
  }
}

function updateSenderFrameUI(info: FrameInfo) {
  if (info.totalFrames > 0) {
    const blockIndex = (info.seq % info.totalFrames) + 1;
    senderFrameIndicator.textContent = `${blockIndex} / ${info.totalFrames}`;
    if (senderSlotsIndicator) {
      senderSlotsIndicator.textContent = `${info.fps} FPS`;
    }
    if (senderPageBadge) senderPageBadge.textContent = `BLOCK ${String(blockIndex).padStart(3, '0')} / ${String(info.totalFrames).padStart(3, '0')}`;
    if (fsPageIndicator) fsPageIndicator.textContent = `BLOCK ${String(blockIndex).padStart(3, '0')} / ${String(info.totalFrames).padStart(3, '0')}`;

    const pct = Math.round((blockIndex / info.totalFrames) * 100);
    if (senderFramePct) senderFramePct.textContent = `${pct}%`;
    if (senderPctIndicator) senderPctIndicator.textContent = `${pct}%`;
    senderProgressFill.style.width = `${pct}%`;
    senderLoopCounter.textContent = `${info.loopCount}`;

    if (senderFrameTypeBadge) {
      senderFrameTypeBadge.className = 'badge-frame-type';
      if (info.isRepairFrame) {
        senderFrameTypeBadge.classList.add('type-data');
        senderFrameTypeBadge.textContent = '[ FOUNTAIN REPAIR // PARITY ]';
      } else {
        senderFrameTypeBadge.classList.add('type-start');
        senderFrameTypeBadge.textContent = `[ SYSTEMATIC BLOCK ${blockIndex} / ${info.totalFrames} ]`;
      }
    }
  } else {
    senderFrameIndicator.textContent = '0 / 0';
    if (senderSlotsIndicator) senderSlotsIndicator.textContent = `${info.fps} FPS`;
    if (senderPageBadge) senderPageBadge.textContent = 'BLOCK 000 / 000';
    if (senderFramePct) senderFramePct.textContent = '0%';
    if (senderPctIndicator) senderPctIndicator.textContent = '0%';
    senderProgressFill.style.width = '0%';
    senderLoopCounter.textContent = '0';
    if (senderFrameTypeBadge) {
      senderFrameTypeBadge.className = 'badge-frame-type type-idle';
      senderFrameTypeBadge.textContent = 'AWAITING_INPUT';
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

    const frameBytes = parseInt(chunkSizeSelect.value, 10) || DEFAULT_FRAME_BYTES;
    await sender.loadFile(file, frameBytes);

    const info = sender.getFrameInfo();
    senderFrameCount.textContent = `${info.totalFrames} BLOCKS`;
    if (senderTransferId) senderTransferId.textContent = `#${info.sessionId.toString(16).toUpperCase().padStart(4, '0')}`;
    if (senderTotalFramesDesc) {
      senderTotalFramesDesc.textContent = info.compression === 'gzip'
        ? `[GZIP: ${formatBytes(info.transmittedSize)} (${Math.round((1 - info.transmittedSize / file.size) * 100)}% saved) • ${info.totalFrames} BLOCKS]`
        : `[RAW: ${formatBytes(info.transmittedSize)} • ${info.totalFrames} BLOCKS @ ${info.frameBytes}B/QR]`;
    }

    const estSeconds = (info.totalFrames / sender.getFps()).toFixed(1);
    senderCycleTime.textContent = `~${estSeconds}s / CYCLE (${sender.getFps()} FPS)`;

    senderPlaceholder.classList.add('hidden');
  } catch (err: any) {
    console.error('Failed to load file:', err);
    showSenderAlert(`Error loading file: ${err.message || err}`, 'error');
  }
}

if (btnSenderPair) {
  btnSenderPair.addEventListener('click', async () => {
    clearSenderAlert();
    try {
      await sender.renderPairingQr();
      showSenderAlert('Optical Pairing QR displayed. Point receiver camera here to pair!', 'info');
    } catch (err: any) {
      showSenderAlert(`Pairing error: ${err.message || err}`, 'error');
    }
  });
}



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
  const fps = parseInt(fpsSlider.value, 10);
  fpsLabel.textContent = `${fps} FPS`;
  sender.setFps(fps);
  const info = sender.getFrameInfo();
  if (info.totalFrames > 0) {
    const estSeconds = (info.totalFrames / sender.getFps()).toFixed(1);
    senderCycleTime.textContent = `~${estSeconds}s / cycle (${sender.getFps()} FPS)`;
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

// Fullscreen in-overlay 5 controls
if (btnFsStart) {
  btnFsStart.addEventListener('click', () => sender.start());
}
if (btnFsPause) {
  btnFsPause.addEventListener('click', () => sender.pause());
}
if (btnFsStop) {
  btnFsStop.addEventListener('click', () => sender.stop());
}
if (btnFsPrev) {
  btnFsPrev.addEventListener('click', () => sender.prevFrame());
}
if (btnFsNext) {
  btnFsNext.addEventListener('click', () => sender.nextFrame());
}

// ================= RECEIVER CONTROLLER =================
const receiverVideo = document.getElementById('receiver-video') as HTMLVideoElement;
const btnCameraToggle = document.getElementById('btn-camera-toggle') as HTMLButtonElement;
const cameraBtnText = document.getElementById('camera-btn-text') as HTMLSpanElement;
const btnCameraFlip = document.getElementById('btn-camera-flip') as HTMLButtonElement;
const cameraSelect = document.getElementById('camera-select') as HTMLSelectElement;
const cameraPlaceholder = document.getElementById('camera-placeholder') as HTMLDivElement;
const viewfinderOverlay = document.getElementById('viewfinder-overlay') as HTMLDivElement;
const recPairingStatus = document.getElementById('rec-pairing-status') as HTMLSpanElement | null;
const recPairingText = document.getElementById('rec-pairing-text') as HTMLSpanElement | null;

const receiverStatusDot = document.getElementById('receiver-status-dot') as HTMLSpanElement;
const receiverStatusText = document.getElementById('receiver-status-text') as HTMLSpanElement;
const btnReceiverReset = document.getElementById('btn-receiver-reset') as HTMLButtonElement;

const recSessionId = document.getElementById('rec-session-id') as HTMLSpanElement | null;
const recProtocolStatus = document.getElementById('rec-protocol-status') as HTMLSpanElement | null;
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

// Decimen scanner HUD & overlay elements
const detectOverlay = document.getElementById('detect-overlay') as HTMLCanvasElement;
const hudProgressLabel = document.getElementById('hud-progress-label') as HTMLElement | null;
const hudEtaLabel = document.getElementById('hud-eta-label') as HTMLElement | null;
const hudProgressBar = document.getElementById('hud-progress-bar') as HTMLElement | null;

const noSignalToast = document.getElementById('no-signal-toast') as HTMLElement | null;
const btnNoSignalHelp = document.getElementById('btn-no-signal-help') as HTMLButtonElement | null;
const btnNoSignalDismiss = document.getElementById('btn-no-signal-dismiss') as HTMLButtonElement | null;
const noSignalDialog = document.getElementById('no-signal-dialog') as HTMLDialogElement | null;
const noSignalCloseBtn = document.getElementById('no-signal-close-btn') as HTMLButtonElement | null;

const cameraFpsSelect = document.getElementById('camera-fps-select') as HTMLSelectElement | null;
const cameraResSelect = document.getElementById('camera-res-select') as HTMLSelectElement | null;

const mCapFps = document.getElementById('m-cap-fps') as HTMLElement | null;
const mDecFps = document.getElementById('m-dec-fps') as HTMLElement | null;
const mGoodput = document.getElementById('m-goodput') as HTMLElement | null;
const mElapsed = document.getElementById('m-elapsed') as HTMLElement | null;
const mFramesRatio = document.getElementById('m-frames-ratio') as HTMLElement | null;
const mBlocksK = document.getElementById('m-blocks-k') as HTMLElement | null;
const mBlockLen = document.getElementById('m-block-len') as HTMLElement | null;
const mPayloadSize = document.getElementById('m-payload-size') as HTMLElement | null;
const diagLinkIndicator = document.getElementById('diag-link-indicator') as HTMLElement | null;

let isCameraActive = false;
let currentFacingMode: 'environment' | 'user' = 'environment';
let availableCameras: MediaDeviceInfo[] = [];

const receiver = new OpticalReceiver({
  onStateChange: (state: ReceiverState, detail?: string) => {
    receiverStatusDot.className = 'status-dot';
    switch (state) {
      case 'IDLE':
        receiverStatusDot.classList.add('dot-idle');
        receiverStatusText.textContent = 'Camera Off';
        if (diagLinkIndicator) {
          diagLinkIndicator.className = 'diag-link-idle';
          diagLinkIndicator.textContent = 'STANDBY';
        }
        break;
      case 'STARTING':
        receiverStatusDot.classList.add('dot-paused');
        receiverStatusText.textContent = 'Starting Camera...';
        if (diagLinkIndicator) {
          diagLinkIndicator.className = 'diag-link-idle';
          diagLinkIndicator.textContent = 'STARTING';
        }
        break;
      case 'SCANNING':
        receiverStatusDot.classList.add('dot-active');
        receiverStatusText.textContent = 'Scanning for QR Frames...';
        if (diagLinkIndicator) {
          diagLinkIndicator.className = 'diag-link-idle';
          diagLinkIndicator.textContent = 'SCANNING';
        }
        break;
      case 'RECEIVING':
        receiverStatusDot.classList.add('dot-active');
        receiverStatusText.textContent = 'Capturing Fountain Stream';
        if (diagLinkIndicator) {
          diagLinkIndicator.className = 'diag-link-active';
          diagLinkIndicator.textContent = 'LINK ACTIVE';
        }
        break;
      case 'COMPLETE':
        receiverStatusDot.classList.add('dot-active');
        receiverStatusText.textContent = 'Transfer Complete!';
        if (diagLinkIndicator) {
          diagLinkIndicator.className = 'diag-link-active';
          diagLinkIndicator.textContent = 'COMPLETE';
        }
        break;
      case 'ERROR':
        receiverStatusDot.classList.add('dot-error');
        receiverStatusText.textContent = detail || 'Error';
        if (diagLinkIndicator) {
          diagLinkIndicator.className = 'diag-link-idle';
          diagLinkIndicator.textContent = 'ERROR';
        }
        break;
    }
  },
  onProgress: (progress: ReceiverProgress, header: FrameHeader | null) => {
    updateReceiverDashboard(progress, header);
  },
  onDiagnostics: (diag) => {
    if (mCapFps) mCapFps.textContent = `${diag.captureFps}`;
    if (mDecFps) mDecFps.textContent = `${diag.decodeFps}`;
    if (mGoodput) mGoodput.textContent = diag.goodput > 0 ? `${(diag.goodput / 1024).toFixed(1)} KB/s` : '--';
    if (mElapsed) mElapsed.textContent = `${diag.elapsed.toFixed(1)}s`;
    if (mFramesRatio) mFramesRatio.textContent = `${diag.framesNew} / ${diag.framesDup}`;
    if (mBlocksK) mBlocksK.textContent = diag.blocksK > 0 ? `${diag.blocksK}` : '--';
    if (mBlockLen) mBlockLen.textContent = `${diag.blockLen} B`;
    if (mPayloadSize) mPayloadSize.textContent = diag.transferBytes > 0 ? formatBytes(diag.transferBytes) : '--';

    // In-viewfinder HUD
    if (hudProgressLabel) {
      hudProgressLabel.textContent = `${diag.progressPercent}% · ${diag.framesNew} frames`;
    }
    if (hudEtaLabel) {
      if (diag.etaSeconds !== null && diag.etaSeconds > 0) {
        hudEtaLabel.textContent = `~${diag.etaSeconds}s remaining`;
      } else if (diag.etaSeconds === 0) {
        hudEtaLabel.textContent = 'Verifying SHA-256…';
      } else if (diag.blocksK > 0) {
        hudEtaLabel.textContent = 'Solving fountain…';
      } else {
        hudEtaLabel.textContent = 'Awaiting stream…';
      }
    }
    if (hudProgressBar) {
      hudProgressBar.style.width = `${diag.progressPercent}%`;
    }
  },
  onNoSignal: (visible: boolean) => {
    if (noSignalToast) {
      if (visible) noSignalToast.classList.remove('hidden');
      else noSignalToast.classList.add('hidden');
    }
  },
  onFileComplete: (reconstructed: ReconstructedFile) => {
    displayReconstructedFile(reconstructed);
  },
  onError: (err) => {
    alert(`Camera error: ${err.message}`);
  }
});

function updateReceiverDashboard(progress: ReceiverProgress, _header: FrameHeader | null) {
  if (recPairingStatus && recPairingText) {
    if (progress.sessionId) {
      recPairingStatus.className = 'badge-pairing-state linked';
      recPairingText.textContent = `🔗 Locked (#${progress.sessionId.toString(16).toUpperCase()})`;
    } else {
      recPairingStatus.className = 'badge-pairing-state unlinked';
      recPairingText.textContent = 'Awaiting Stream';
    }
  }

  if (recSessionId) {
    recSessionId.textContent = progress.sessionId ? `#${progress.sessionId.toString(16).toUpperCase()} (Locked)` : 'Awaiting Stream';
  }

  if (recProtocolStatus) {
    recProtocolStatus.textContent = `Fountain: ${progress.solvedCount}/${progress.k} blocks (${progress.framesNew} frames caught)`;
    recProtocolStatus.className = 'info-value font-mono text-cyan';
  }

  if (progress.k > 0) {
    recChunkCount.textContent = `${progress.solvedCount} / ${progress.k} (${progress.percent}%)`;
    recProgressFill.style.width = `${progress.percent}%`;

    const remaining = progress.k - progress.solvedCount;
    if (remaining > 0) {
      recMissingChunks.textContent = `${remaining} block(s) needed`;
      recMissingChunks.className = 'info-value font-mono text-warning';
    } else {
      recMissingChunks.textContent = 'All blocks solved! Verifying SHA-256...';
      recMissingChunks.className = 'info-value font-mono text-success';
    }

    matrixStatus.textContent = `${progress.solvedCount}/${progress.k} blocks`;

    if (chunkGrid.children.length !== progress.k) {
      chunkGrid.innerHTML = '';
      for (let i = 0; i < progress.k; i++) {
        const cell = document.createElement('div');
        cell.className = 'chunk-cell';
        cell.id = `chunk-cell-${i}`;
        cell.textContent = `${i + 1}`;
        chunkGrid.appendChild(cell);
      }
    }

    for (let i = 0; i < progress.k; i++) {
      const cell = document.getElementById(`chunk-cell-${i}`);
      if (cell) {
        cell.classList.toggle('received', i < progress.solvedCount);
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
  if (recPairingStatus && recPairingText) {
    recPairingStatus.className = 'badge-pairing-state unlinked';
    recPairingText.textContent = 'Not Connected (Scan Pairing QR)';
  }
});

btnReceiverReset.addEventListener('click', () => {
  receiver.resetTransfer();
  reconstructedCard.classList.add('hidden');
  filePreviewArea.classList.add('hidden');
  if (recPairingStatus && recPairingText) {
    recPairingStatus.className = 'badge-pairing-state unlinked';
    recPairingText.textContent = 'Not Connected (Scan Pairing QR)';
  }
});

// Camera controls
async function startCameraSession() {
  try {
    const selectedDeviceId = cameraSelect.value || undefined;
    const idealFps = cameraFpsSelect ? Number(cameraFpsSelect.value) : 60;
    const idealWidth = cameraResSelect ? Number(cameraResSelect.value) : 1280;

    receiver.setOverlayCanvas(detectOverlay);
    await receiver.startCamera(receiverVideo, selectedDeviceId, currentFacingMode, detectOverlay, idealWidth, idealFps);
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
      const autoOpt = document.createElement('option');
      autoOpt.value = '';
      autoOpt.textContent = 'Auto Camera';
      cameraSelect.appendChild(autoOpt);

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
  if (noSignalToast) noSignalToast.classList.add('hidden');
}

// Aspect ratio synchronization to eliminate letterboxing/cropping
receiverVideo.addEventListener('resize', () => {
  if (receiverVideo.videoWidth && receiverVideo.videoHeight) {
    const container = document.getElementById('viewfinder-container');
    if (container) {
      container.style.aspectRatio = `${receiverVideo.videoWidth} / ${receiverVideo.videoHeight}`;
    }
  }
});

// No Signal toast and tips dialog
btnNoSignalHelp?.addEventListener('click', () => {
  noSignalDialog?.showModal();
});
btnNoSignalDismiss?.addEventListener('click', () => {
  noSignalToast?.classList.add('hidden');
});
noSignalCloseBtn?.addEventListener('click', () => {
  noSignalDialog?.close();
});
noSignalDialog?.addEventListener('click', (e) => {
  if (e.target === noSignalDialog) noSignalDialog.close();
});

cameraFpsSelect?.addEventListener('change', async () => {
  if (isCameraActive) {
    stopCameraSession();
    await startCameraSession();
  }
});

cameraResSelect?.addEventListener('change', async () => {
  if (isCameraActive) {
    stopCameraSession();
    await startCameraSession();
  }
});

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
    if (progress.k > 0) {
      sandboxRecProgress.textContent = `${progress.solvedCount} / ${progress.k} (${progress.percent}%)`;
      sandboxProgressFill.style.width = `${progress.percent}%`;

      if (sandboxChunkGrid.children.length !== progress.k) {
        sandboxChunkGrid.innerHTML = '';
        for (let i = 0; i < progress.k; i++) {
          const cell = document.createElement('div');
          cell.className = 'chunk-cell';
          cell.id = `sb-chunk-cell-${i}`;
          cell.textContent = `${i + 1}`;
          sandboxChunkGrid.appendChild(cell);
        }
      }

      for (let i = 0; i < progress.k; i++) {
        const cell = document.getElementById(`sb-chunk-cell-${i}`);
        if (cell) {
          cell.classList.toggle('received', i < progress.solvedCount);
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
