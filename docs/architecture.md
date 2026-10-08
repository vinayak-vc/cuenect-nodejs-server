# Architecture: Cuenect Node.js Signaling Bridge Server

## 1. System Topology
```
┌──────────────────────────────────────────────────────────────┐
│ Windows Host                                                 │
│                                                              │
│  [Unity Stage Application]                                   │
│        ▲                                                     │
│        │ Socket.IO (Port 9000)                               │
│        ▼                                                     │
│  [cuenect-nodejs-server] ─── Reads ───> Local .glb Models    │
│     ├── Socket.IO Relay                                      │
│     ├── HTTP Server (/api/model, /api/model-info)            │
│     ├── GLB Inspector (Header + Chunk 0 JSON Parser)         │
│     └── Control State Manager                                │
└────────┬─────────────────────────────────────────────────────┘
         │ HTTP + Socket.IO (Local Wi-Fi or Ngrok Tunnel)
         ▼
┌──────────────────────────────────────────────────────────────┐
│ cuenect-webfront-offline (Browser / Mobile / Tablet)         │
│  - 3D Interactive WebGL Touch View (Three.js)                │
│  - Classic D-Pad Controller                                  │
└──────────────────────────────────────────────────────────────┘
```

## 2. Core Modules
- **`src/signalingServer.js`**: Core HTTP and Socket.IO server. Handles authentication (`stage` vs `controller`), room distribution, allowlisted event relays, and HTTP asset endpoints.
- **`src/glbInspector.js`**: Fast binary header parser. Reads 12-byte header + Chunk 0 JSON from disk. Calculates:
  - Total file size (bytes / MB)
  - Triangle count from accessor index/position counts
  - Vertex count
  - Mesh count and bounding box dimensions
  - `isLoadable` validation ($\le 25\text{ MB}$ and $\le 250,000$ triangles)
- **`src/tunnelManager.js`**: Cloud tunnel interface integrating `@ngrok/ngrok`.
- **`src/dashboard.js`**: Low-overhead ANSI terminal dashboard.
- **`src/config.js`**: CLI arguments and persistent token store.

## 3. HTTP API Endpoints
| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/health`, `/status` | `GET` | Health check, uptime, and connection counts. |
| `/api/model-info?path=...` | `GET` | Returns GLB metadata, poly count, and `isLoadable`. |
| `/api/model?path=...` | `GET`, `HEAD` | Streams GLB binary. Supports HTTP 206 `Range: bytes` and CORS. Returns 413 if over threshold without `?force=true`. |
