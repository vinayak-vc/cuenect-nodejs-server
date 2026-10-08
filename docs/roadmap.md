# Roadmap: Cuenect Node.js Signaling Bridge Server

## Milestone 1: Model Metadata & Asset Streaming (Completed)
- [x] Implement zero-overhead binary GLB header and Chunk 0 inspector (`src/glbInspector.js`).
- [x] Add 25 MB file size and 250k triangle limit checks.
- [x] Add `/api/model-info` and `/api/model` streaming endpoints with HTTP Range and CORS support.
- [x] Enrich `cachedAssets` and live stage catalog broadcasts with model metrics.
- [x] Add automated test suite (`test/testGlbEndpoints.js`).

## Milestone 2: Caching & Performance Optimization
- [ ] LRU memory caching of inspected GLB metadata to avoid re-reading disk headers on repeated requests.
- [ ] Support gzip / br compression for JSON endpoints.

## Milestone 3: Dynamic Model Uploads & Sync
- [ ] Allow authenticated controllers to upload lightweight glb assets directly to the server for live stage injection.
