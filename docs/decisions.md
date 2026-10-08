# Decisions: Cuenect Node.js Signaling Bridge Server

## D-001: Zero-Dependency Binary GLB Inspection
- **Context**: Needed to calculate 3D model file size and triangle/vertex counts before web controllers attempt to download or render models.
- **Alternatives Considered**:
  1. Relying on heavy npm packages (`@gltf-transform/core`, `three`).
  2. Reading only HTTP `Content-Length`.
  3. Reading the binary container header + Chunk 0 JSON using native Node.js `fs` buffers.
- **Decision**: Implemented native 20-byte header + Chunk 0 JSON reader in `src/glbInspector.js`.
- **Rationale**:
  - Requires 0 external dependencies.
  - Takes < 2 milliseconds to parse directly from disk.
  - Reads only the JSON structural definitions, completely skipping the heavy 98% binary mesh buffer (BIN chunk).
  - Can accurately compute triangle counts (`indices.count / 3` or `POSITION.count / 3`) and instanced mesh duplicates.

## D-002: Model Size & Polycount Thresholds
- **Decision**: Set `MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024` (25 MB) and `MAX_TRIANGLE_COUNT = 250,000` triangles.
- **Rationale**: Models within this budget run smoothly at 60fps on typical mobile browsers and lower-spec tablets without crashing the WebGL context. Anything larger is gated for direct stage control via D-Pad.

## D-003: Ngrok Browser Warning Bypass & CORS Preflight Support
- **Context**: Free ngrok endpoints intercept browser HTTP requests with an HTML warning page (`ERR_NGROK_6024`) which lacks `Access-Control-Allow-Origin`, causing browser fetch calls to fail with CORS errors.
- **Decision**:
  1. Permit `ngrok-skip-browser-warning` and `*` in `Access-Control-Allow-Headers`.
  2. Implement an explicit 204 response on `OPTIONS` preflights with `Access-Control-Max-Age: 86400`.
  3. Send `ngrok-skip-browser-warning: true` header and URL query param from client loaders.

## D-004: HTTP Browser Caching & Conditional 304 Validation
- **Decision**: Added `Cache-Control: public, max-age=604800, stale-while-revalidate=86400`, `ETag` (based on file size and mtime), `Last-Modified`, and HTTP 304 Not Modified validation for `/api/model`.
- **Rationale**:
  - Without caching headers, mobile browsers and Three.js re-downloaded multi-megabyte GLB assets repeatedly, rapidly exhausting ngrok's 1 GB monthly outbound transfer quota.
  - Adding standard HTTP caching headers allows clients to store the binary assets in local browser disk cache, achieving 0 bytes of network transfer on repeated views.
