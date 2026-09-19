# Luma — Cross-Device Optical File Transfer Platform

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/shriyanshthanneeru2407-dotcom/luma-optical-transfer)

**Luma** is a high-speed, air-gapped cross-device file transfer application that streams binary files visually between screens and cameras using rapidly cycling animated QR code frames.

- 🌐 **Zero Network Connection Required**: Transfers data without Wi-Fi, Bluetooth, local area networks, or cellular data.
- 🔒 **Zero Cloud Storage**: No intermediary cloud server touches your file. Data moves directly via light photons from screen to camera.
- ⚡ **Instant Deploy**: Ready to run on Vercel with zero configuration.

---

## 🚀 Live Vercel Deployment Link

You can deploy and access your live instance of Luma on Vercel:

👉 **[Deploy Luma to Vercel (1-Click)](https://vercel.com/new/clone?repository-url=https://github.com/shriyanshthanneeru2407-dotcom/luma-optical-transfer)**

GitHub Repository:
👉 **[https://github.com/shriyanshthanneeru2407-dotcom/luma-optical-transfer](https://github.com/shriyanshthanneeru2407-dotcom/luma-optical-transfer)**

---

## Features (Phase 1 Proof of Concept)

### 📤 Sender Mode
- **File Picker & Drag-and-Drop**: Native `<label>` file picker with window-level drag protection.
- **Quick Sample Files**: 1-click sample text and sample image generators for instant testing.
- **Dynamic Chunking**: Configurable payload densities (150B, 220B, 320B) with IEEE 802.3 CRC32 integrity checksums.
- **Sequential QR Carousel**: Crisp QR rendering on high-contrast canvas with quiet margins.
- **Transmission Controls**:
  - `Start Loop` — Continuous cyclic frame playback ($0 \to N-1 \to 0$).
  - `Pause` / `Stop` / `Prev Frame` / `Next Frame`.
  - `FPS Speed Slider` — Configurable 1 to 10 FPS (default 4 FPS).
- **Live Telemetry**: Real-time frame counter (`Frame 3 / 12`), progress bar, and loop cycle counter.

### 📷 Receiver Mode
- **Camera Viewfinder**: Live camera feed with reticle overlay and animated scanline guide.
- **Dual Detection Engine**: Native hardware-accelerated `BarcodeDetector` with automatic `jsQR` fallback for 100% universal browser compatibility.
- **Chunk Reassembly**:
  - Out-of-order frame capture and deduplication.
  - Interactive **Chunk Matrix** (visual map with green illuminated badges as chunks arrive).
  - Missing frames indicator (e.g. `Waiting for frames: #2, #5`).
- **File Reconstruction & Download**:
  - Bit-for-bit file reassembly with CRC32 integrity verification.
  - Confetti celebration burst.
  - In-browser text & image preview.
  - Direct `Download File` button.

### ⚡ Self-Test Loopback Sandbox
- Test and inspect the full optical pipeline on a single device without needing a second physical device or camera.

---

## Local Development

```bash
git clone https://github.com/shriyanshthanneeru2407-dotcom/luma-optical-transfer.git
cd luma-optical-transfer
npm install
npm run dev -- --host
```

## Running Tests

```bash
npm run test
```
