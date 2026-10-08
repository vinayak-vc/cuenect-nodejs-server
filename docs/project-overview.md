# Project Overview: Cuenect Node.js Signaling Bridge Server

## 1. Executive Summary
`cuenect-nodejs-server` (`cuenect-signaling-bridge`) is the local and cloud-connected communication hub for the Cuenect Hologram Stage platform. It provides non-blocking, bidirectional Socket.IO relay between the Unity Stage presentation runtime and web/mobile controller clients (`cuenect-webfront-offline`), alongside direct HTTP asset streaming and metadata inspection.

## 2. Key Responsibilities
- **Socket.IO Relay**: Relays real-time events (`hologram-asset-action`, `hologram-model-action`, `hologram-joystick-action`, `hologram-action`, `StereoSettingsActionKey`, etc.) between Unity and Web controllers.
- **Single-Operator Concurrency Lock**: Guarantees that only one connected operator can drive the live stage at a time while allowing observers to join.
- **Catalog Caching & Enrichment**: Pre-loads and caches `CuenectDatabase.json` on boot, immediately streaming the asset library to late-joining web controllers.
- **GLB Model Inspection & Size Gating**: Inspects 3D GLB headers directly from disk in <2ms to determine byte size, polygon count, and 3D dimensions. Enforces a 25 MB and 250k triangle limit for web previewability.
- **Model Streaming Endpoint**: Serves local 3D GLB files over HTTP (`/api/model`) with HTTP 206 `Range: bytes` and CORS support for progressive web loading.
- **Interactive Terminal Dashboard**: Single-screen ANSI terminal dashboard monitoring active connections, traffic rates, and ngrok tunnel status.
