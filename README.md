# Cuenect Node.js Signaling Bridge Server

High-performance, offline-first **Socket.IO** signaling relay bridge connecting the **Unity Hologram Stage Viewer** and the **React Web Remote Controller**.

---

## Repository Ecosystem

| Repository | Tech Stack | Role |
| :--- | :--- | :--- |
| **`cuenect-nodejs-server`** | Node.js (CommonJS) + Socket.IO | High-throughput realtime signaling relay & pairing bridge (`:9000`) |
| **`cuenect-webfront-offline`** | React 18 + TypeScript + Vite | Web/Mobile remote controller UI (D-Pad, 3D model/video controls, stereo calibration) |
| **`hologram-stage-viewer-application`** | Unity 3D / C# | 3D holographic projection engine, stereoscopic SBS camera rig, and runtime glTF loader |

---

## Features

- **Unified Socket.IO Signaling**: Bi-directional event routing between Unity Desktop Stage and multi-client web controllers.
- **Mid-Session Catalog Caching**: Automatically pre-loads and caches `Documents/Cuenect/CuenectDatabase.json` on boot, immediately streaming the asset library to late-joining web controllers without requiring Unity restarts.
- **Live Terminal Dashboard**: Interactive terminal dashboard displaying live connection counts, packet statistics, active users, and error alerts.
- **Auto-Pairing QR Code Generator**: Renders ANSI QR codes in the terminal for instant local Wi-Fi or public tunnel pairing.
- **Public Tunnel Support**: Integrated `@ngrok/ngrok` tunnel creation for remote cross-network demonstrations over HTTPS/WSS.
- **Windows Standalone Executable**: Pre-configured `pkg` packaging script to compile self-contained `cuenect-server.exe` binaries for zero-dependency deployment.

---

## Getting Started

### Prerequisites
- Node.js 18+ installed

### Installation
```bash
npm install
```

### Running Locally
```bash
npm start
```
*By default, the bridge server listens on port `9000` (e.g. `http://0.0.0.0:9000` & `http://localhost:9000/socket.io/`).*

### Custom Port & Tunnel Flags
```bash
# Start on custom port
node server.js --port 9005

# Start with public ngrok tunnel
node server.js --tunnel
```

---

## Building Standalone Binary

To build a standalone `.exe` for Windows deployment without requiring Node.js on the kiosk machine:

```bash
npm run build-win
```
The compiled executable will be placed in `dist/cuenect-server.exe`.

---

## Event Relay Protocol

The server relays the following typed Socket.IO events between clients:

| Event Name | Direction | Description |
| :--- | :--- | :--- |
| `login` | Client → Server | Client registration with username |
| `login_response` | Server → Client | User list and authentication confirmation |
| `hologram-asset-list` | Stage ↔ Server ↔ Remote | Full catalog of available 3D models, videos, and images |
| `hologram-asset-action` | Remote → Stage | Load selected 3D model, video, or image |
| `hologram-model-action` | Remote → Stage | Model reset, close, or face snap command |
| `hologram-joystick-action` | Remote → Stage | Continuous D-Pad analog translation / zoom vectors |
| `hologram-video-action` | Remote → Stage | Video transport (Play, Pause, Stop, Seek, Volume, Mute) |
| `hologram-action` | Remote → Stage | Switch movable mode (`rotate`, `pan`, `spotlight`, `magnifier`) |
| `StereoSettingsActionKey` | Remote → Stage | Live stereoscopic SBS optical calibration (IPD, FOV, Parallax, Light) |
| `hologram-camera-orthographic-action` | Remote → Stage | Toggle perspective vs. orthographic camera projection |
| `message` / `stage-message` | Bi-directional | Raw stage protocol queries (`ReqAsset`, `SendingAssets#`, `ModelImageRequest#`) |

---

## Project Structure

```
cuenect-nodejs-server/
├── dist/                  # Compiled standalone binaries (cuenect-server.exe)
├── src/
│   ├── config.js          # CLI arguments and environment configuration
│   ├── dashboard.js       # Terminal UI dashboard and metric counters
│   ├── network.js         # Local network interface resolution (LAN IP discovery)
│   ├── qrGenerator.js     # QR code rendering (terminal ANSI + base64)
│   ├── signalingServer.js # Core HTTP & Socket.IO server engine
│   ├── tunnelManager.js   # Optional ngrok public tunnel manager
│   └── windowsConsole.js  # Windows console QuickEdit freeze prevention
├── package.json
└── server.js              # Application entrypoint
```
