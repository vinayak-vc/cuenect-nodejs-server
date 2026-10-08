# Tasks: Cuenect Node.js Signaling Bridge Server

| ID | Title | Status | Date | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **T-101** | Create `src/glbInspector.js` | DONE | 2026-09-22 | Implemented 12-byte header + Chunk 0 JSON reader. Extracts file size, triangle count, vertex count, and bounding box dimensions in <2ms. Enforces 25MB / 250k triangle limit. |
| **T-102** | Add `/api/model-info` & `/api/model` | DONE | 2026-09-22 | Added HTTP endpoints to `signalingServer.js` with CORS, HTTP 206 `Range: bytes`, and 413 payload rejection for high-poly models. |
| **T-103** | Catalog Metadata Enrichment | DONE | 2026-09-22 | Enriched `cachedAssets` on boot and live `hologram-asset-list` broadcasts from Unity. |
| **T-104** | Automated Test Suite | DONE | 2026-09-22 | Created and verified `test/testGlbEndpoints.js`. All tests pass. |
| **T-105** | Documentation per `AGENTS.md` | DONE | 2026-09-22 | Created `project-overview.md`, `architecture.md`, `roadmap.md`, `tasks.md`, `decisions.md`, `ai_handoff.md`. |
| **T-106** | Ngrok CORS Preflight & Headers | DONE | 2026-09-22 | Added `ngrok-skip-browser-warning` and `*` to `Access-Control-Allow-Headers` and explicit OPTIONS 204 preflight block with 24-hour cache. |
| **T-107** | HTTP Browser Caching & LAN IP Advertising | DONE | 2026-09-22 | Implemented `Cache-Control` (7-day max-age with stale-while-revalidate), `ETag`, `Last-Modified`, and HTTP 304 Not Modified on `/api/model`. Added `localIp` and `isTunnel` in `/health`, `/status`, and `login_response`. |
