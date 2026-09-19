# OpticalDrop — Cross-Device Optical File Transfer Platform

**OpticalDrop** is an air-gapped, cross-device file transfer application that transmits files visually between screens and cameras using rapidly changing animated QR code frames.

- **Zero Network Required**: Does not require sender and receiver to be on the same Wi-Fi, LAN, or cellular network.
- **Zero Cloud Storage**: No cloud servers or intermediaries touch the file contents. Data moves strictly through light photons from screen to camera lens.

---

## Phase 1 — Basic Proof of Concept (Completed)

### Features

#### 📤 Sender Device
- **Modern Web Interface**: Responsive dark/light theme, high-contrast QR display zone.
- **File Picker & Drag-and-Drop**: Load any local file directly in browser memory.
- **Metadata Telemetry**: Displays original filename, exact file size in bytes/KB, total chunks, and estimated cycle time.
- **Local Chunking**: Slices file into small chunks (customizable: 150B, 220B, 320B) with CRC32 integrity checksums.
- **Sequential QR Display**: High-contrast QR code canvas with quiet margins for optimal camera recognition.
- **Transmission Controls**:
  - `Start Loop` — Continuous cyclic frame carousel ($0 \to N-1 \to 0$).
  - `Pause` — Freeze at current frame.
  - `Stop` — Reset transmission.
  - `Prev Frame` / `Next Frame` — Step manually frame-by-frame.
  - `FPS Slider` — Adjust playback speed (1 to 10 FPS, default 4 FPS).
- **Telemetry Bar**: Live frame counter (e.g. `Frame 3 / 12`), percentage bar, and loop counter.

#### 📷 Receiver Device
- **Camera Viewfinder**:
  - Permission request and live video stream.
  - Facing mode switcher (flip front / rear camera).
  - Target reticle overlay with animated scanline guide.
- **High-Performance Detection**:
  - Hardware-accelerated native `BarcodeDetector` API when available.
  - Pure JS fallback via `jsQR` for 100% universal cross-browser support (Safari, Chrome, Firefox, mobile).
- **Chunk Reassembly & Verification**:
  - Frame deduplication and out-of-order frame capture.
  - Live **Bit-Torrent style Chunk Matrix** showing real-time green badges for captured pieces.
  - Real-time missing frame telemetry (`Waiting for frames: #2, #7`).
- **File Reconstruction & Download**:
  - Bit-for-bit binary reassembly with CRC32 verification.
  - Confetti celebration upon completion!
  - Text & image instant preview.
  - One-click `Download File` button.

#### ⚡ Self-Test Loopback Sandbox
- Test the full optical transmission, frame encoding, image detection, and binary reassembly pipeline on a single device without needing a second physical device or camera! Includes built-in sample text and image generators.

---

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Development Server
```bash
npm run dev -- --host
```
The server will output a local network URL (e.g., `http://192.168.1.X:5173`).

### 3. Cross-Device Testing
1. **Device A (Computer/Sender)**: Open `http://localhost:5173`, stay on **Sender Mode**, choose a file, and click **Start Loop**.
2. **Device B (Phone/Receiver)**: Open the local IP URL on your mobile browser (or a second browser window with webcam), open **Receiver Mode**, tap **Start Camera**, and point the lens at the computer screen.
3. Watch the chunk matrix illuminate green as frames are captured, until the file is reconstructed and ready to download!

### 4. Run Automated Tests
```bash
npm run test
```
Executes protocol serialization tests, CRC validation, and full end-to-end QR canvas pixel generation and scanning tests.
