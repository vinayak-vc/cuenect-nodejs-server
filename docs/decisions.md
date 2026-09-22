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
