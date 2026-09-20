# LumaAir — Air-Gapped Optical File Transfer Platform

🌐 **Live Link**: [https://luma-air.vercel.app](https://luma-air.vercel.app)

**LumaAir** is a high-speed, air-gapped cross-device file transfer application that streams binary files visually between screens and cameras using rapidly cycling animated QR code frames.

- 🌐 **Zero Network Required**: Transfers data without Wi-Fi, Bluetooth, local area networks, or cellular data.
- 🔒 **Zero Cloud Storage**: No intermediary cloud server touches your file. Data moves directly via visible light from screen to camera.
- ⚡ **45 FPS Max & Default**: Hardware-accelerated frame streaming engine optimized for maximum optical reliability.
- 📦 **Luby Transform (LT) Fountain Codes**: Self-healing packet erasure coding reconstructs files even if frames are blurred or dropped.
- 🚀 **WASM High-Density Optical Engine**: Decodes up to 1,465 bytes per QR code in ~4 ms using ZXing-C++ compiled to WebAssembly.
- 📐 **16:9 & 9:16 Adaptive Viewports**: Automatically adapts between widescreen desktop and vertical smartphone aspect ratios.
- 🛡️ **Cryptographic Verification**: End-to-end SHA-256 integrity checks ensure bit-for-bit file accuracy.

---

## 🚀 Live App

👉 **[https://luma-air.vercel.app](https://luma-air.vercel.app)**

GitHub Repository:
👉 **[https://github.com/shriyanshthanneeru2407-dotcom/LumaAir](https://github.com/shriyanshthanneeru2407-dotcom/LumaAir)**

---

## Features

### 📤 Sender Mode (Transmitter)
- **Home Hub 2-Box Selector**: Decimen-style action cards for instantaneous file sending and receiving.
- **Drag-and-Drop Dropzone**: Drag files directly onto the Send card or file dropzone.
- **Optical Pairing Beacon**: Self-describing handshake frame links sender and receiver sessions with celebratory confetti upon connection.
- **Fountain Coding Stream**: Cycles animated QR codes at up to 45 FPS with parity repair frames.
- **Adjustable Payload Densities**: 600B, 1,000B, 1,465B (Decimen standard), 2,000B, and 2,953B (V40 max).
- **Fullscreen Theater Mode**: Maximizes QR code size with floating navigation controls.

### 📷 Receiver Mode (WASM Scanner)
- **ZXing WebAssembly Decoder**: Pre-warmed C++ engine decoding high-density QR frames in milliseconds.
- **Dynamic Corner Brackets Overlay**: Real-time canvas HUD tracking QR coordinates with glowing neon-green alignment brackets.
- **In-Viewfinder HUD**: Real-time progress bar, percentage, and dynamic ETA estimation.
- **Live Optical Telemetry**: Hardware capture FPS, decode FPS, goodput (KB/s), elapsed time, unique vs duplicate frames, and block statistics.
- **Automatic 16:9 & 9:16 Alignment**: Native camera hardware stream matching device screen orientation.
- **Bit-for-Bit SHA-256 Verification & Instant Download**.

---

## Local Development

```bash
git clone https://github.com/shriyanshthanneeru2407-dotcom/LumaAir.git
cd LumaAir
npm install
npm run dev -- --host
```

## Running Tests

```bash
npm run test
```

---

## Author & Copyright

- **Creator & Engineer**: Shriyansh Thanneeru
- **Copyright**: © 2026 LumaAir. All rights reserved.
