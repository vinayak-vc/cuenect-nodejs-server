const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
const { Server: SocketIOServer } = require("socket.io");
const { getMachineIPAddresses } = require("./network");
const { inspectGlb, resolveModelFilePath } = require("./glbInspector");
const { SmithsonianExploreManager } = require("./smithsonianService");

/**
 * Enriches catalog assets with GLB metadata (file size, triangle count, isWebPreviewable)
 */
function enrichAssetCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.assetinformation)) return catalog;
  for (const asset of catalog.assetinformation) {
    const cat = asset.Category !== undefined ? Number(asset.Category) : 0;
    const isGlb = (asset.ModelPath && asset.ModelPath.toLowerCase().includes(".glb")) ||
                  (asset.AssetName && asset.AssetName.toLowerCase().includes(".glb"));
    const isModelCategory = cat === 0 || cat === -1 || cat === 1;

    if ((isGlb || isModelCategory) && (asset.ModelPath || asset.AssetName)) {
      const info = inspectGlb(asset.ModelPath || asset.AssetName);
      asset.fileSizeBytes = info.fileSizeBytes;
      asset.fileSizeMB = info.fileSizeMB;
      asset.triangleCount = info.triangleCount;
      asset.vertexCount = info.vertexCount;
      asset.meshCount = info.meshCount;
      asset.dimensions = info.dimensions;
      asset.isWebPreviewable = info.isLoadable;
      asset.isLoadable = info.isLoadable;
      asset.rejectionReason = info.rejectionReason;
    }
  }
  return catalog;
}

const RELAYABLE_EVENTS = new Set([
  "hologram-asset-action",
  "hologram-model-action",
  "hologram-joystick-action",
  "hologram-video-action",
  "hologram-action",
  "hologram-diya-action",
  "hologram-audioSource-action",
  "hologram-camera-orthographic-action",
  "StereoSettingsActionKey",
  "hologram-display-mode-action",
  "hologram-default-display-mode-action",
  "hologram-environment-action",
  "hologram-model-transform",
  "hologram-metadata-action",
  "explore-download-start",
  "explore-download-progress",
  "explore-download-complete",
  "explore-download-error",
  "control-lock-state",
  "hologram-asset-list",
  "hologram-asset-progress",
  "qr-code",
  "socket-disconnect",
  "message",
  "stage-message",
  "stage-register",
  "stage-registered",
  "stage-state-update",
  "stage-roster-update",
  "dispatch-command",
  "get-stages-roster"
]);

class SignalingServer {
  constructor(port = 9000, host = null) {
    this.port = port;
    this.host = host;
    this.httpServer = null;
    this.io = null;
    this.publicTunnelUrl = null;
    this.activeSocketIOUsers = new Map();
    this.roles = new Map();
    // Multi-stage registry:
    // stages: Map<stageId, { stageId, socketId, displayName, group, online, currentModel, displayMode, lastSeen }>
    this.stages = new Map();
    // socketToStageId: Map<socketId, stageId>
    this.socketToStageId = new Map();
    // Socket id of the controller currently allowed to drive the stage. Null
    // means the stage is unclaimed and the next controller command takes it.
    this.controlHolder = null;
    this.stageSecret = crypto.randomBytes(16).toString("hex");
    this.dashboard = null;
    this.cachedAssets = null;
    this.exploreManager = new SmithsonianExploreManager();
    this.loadLocalAssetDatabase();

    // Hardware/System persistent mapping: systemId -> { stageId, displayName, group }
    this.systemToStage = new Map();
    this.stageRegistryFilePath = path.join(__dirname, "..", "config", "stage-registry.json");
    this.loadSystemRegistry();
  }

  loadSystemRegistry() {
    try {
      if (fs.existsSync(this.stageRegistryFilePath)) {
        const raw = fs.readFileSync(this.stageRegistryFilePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          for (const [sysId, info] of Object.entries(parsed)) {
            this.systemToStage.set(sysId, info);
          }
        }
      }
    } catch (err) {
      console.warn("[SignalingServer] Could not load stage-registry.json:", err.message);
    }
  }

  saveSystemRegistry() {
    try {
      const obj = {};
      for (const [sysId, info] of this.systemToStage.entries()) {
        obj[sysId] = info;
      }
      const dir = path.dirname(this.stageRegistryFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.stageRegistryFilePath, JSON.stringify(obj, null, 2), "utf8");
    } catch (err) {
      console.warn("[SignalingServer] Could not save stage-registry.json:", err.message);
    }
  }

  getCandidateDbPaths() {
    const userProfile = process.env.USERPROFILE || process.env.HOME || "";
    const oneDrive = process.env.OneDrive || "";
    const candidateDbPaths = [];

    if (oneDrive) {
      candidateDbPaths.push(path.join(oneDrive, "Documents", "Cuenect", "CuenectDatabase.json"));
    }

    if (userProfile && fs.existsSync(userProfile)) {
      try {
        const userEntries = fs.readdirSync(userProfile, { withFileTypes: true });
        for (const entry of userEntries) {
          if (entry.isDirectory() && entry.name.toLowerCase().startsWith("onedrive")) {
            candidateDbPaths.push(path.join(userProfile, entry.name, "Documents", "Cuenect", "CuenectDatabase.json"));
          }
        }
      } catch {}
      candidateDbPaths.push(path.join(userProfile, "Documents", "Cuenect", "CuenectDatabase.json"));
    }

    return Array.from(new Set(candidateDbPaths));
  }

  getPrimaryModelsDirectory() {
    const dbPaths = this.getCandidateDbPaths();
    for (const dbPath of dbPaths) {
      if (fs.existsSync(dbPath)) {
        const dir = path.join(path.dirname(dbPath), "models");
        if (!fs.existsSync(dir)) {
          try {
            fs.mkdirSync(dir, { recursive: true });
          } catch {}
        }
        return dir;
      }
    }
    const fallbackBase =
      dbPaths[0] ? path.dirname(dbPaths[0]) : path.join(__dirname, "..");
    const modelsDir = path.join(fallbackBase, "models");
    if (!fs.existsSync(modelsDir)) {
      try {
        fs.mkdirSync(modelsDir, { recursive: true });
      } catch {}
    }
    return modelsDir;
  }

  saveAssetToDatabase(newAsset) {
    if (!this.cachedAssets || !Array.isArray(this.cachedAssets.assetinformation)) {
      this.cachedAssets = { assetinformation: [] };
    }

    const list = this.cachedAssets.assetinformation;
    const idx = list.findIndex(
      (a) =>
        a &&
        (a.AssetID === newAsset.AssetID ||
          (newAsset.smithsonianId && a.smithsonianId === newAsset.smithsonianId))
    );
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...newAsset };
    } else {
      list.push(newAsset);
    }

    const dbPaths = this.getCandidateDbPaths();
    let savedAny = false;
    const serialized = JSON.stringify({ assetinformation: list }, null, 2);

    for (const dbPath of dbPaths) {
      if (fs.existsSync(dbPath) || fs.existsSync(path.dirname(dbPath))) {
        try {
          const dir = path.dirname(dbPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(dbPath, serialized, "utf-8");
          savedAny = true;
        } catch {}
      }
    }

    if (!savedAny && dbPaths.length > 0) {
      try {
        const dir = path.dirname(dbPaths[0]);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dbPaths[0], serialized, "utf-8");
      } catch {}
    }
  }

  mergeIncomingStageCatalog(incoming) {
    const enriched = enrichAssetCatalog(incoming);
    if (!enriched || !Array.isArray(enriched.assetinformation)) {
      return this.cachedAssets || enriched;
    }

    const existingList = this.cachedAssets?.assetinformation || [];
    const byId = new Map();
    for (const oldItem of existingList) {
      if (oldItem && oldItem.AssetID) {
        byId.set(oldItem.AssetID, oldItem);
      }
    }

    // Preserve metadata and smithsonianId on assets that Unity echoes back
    for (const item of enriched.assetinformation) {
      if (!item || !item.AssetID) continue;
      const prev = byId.get(item.AssetID);
      if (prev) {
        if (!item.metadata && prev.metadata) item.metadata = prev.metadata;
        if (!item.smithsonianId && prev.smithsonianId) item.smithsonianId = prev.smithsonianId;
      }
    }

    // Also keep any newly downloaded Smithsonian models that Unity hasn't reloaded from disk yet
    const incomingIds = new Set(enriched.assetinformation.map((a) => a?.AssetID).filter(Boolean));
    for (const oldItem of existingList) {
      if (oldItem && oldItem.smithsonianId && !incomingIds.has(oldItem.AssetID)) {
        enriched.assetinformation.push(oldItem);
      }
    }

    return enriched;
  }

  triggerExploreDownload(model, initiator = "web") {
    const targetDir = this.getPrimaryModelsDirectory();
    return this.exploreManager
      .downloadModel({
        model,
        initiator,
        targetDir,
        onProgress: (state) => {
          if (this.io) {
            this.io.emit("explore-download-progress", state);
          }
        },
        onComplete: (doneState) => {
          if (doneState && doneState.asset) {
            this.saveAssetToDatabase(doneState.asset);
          }
          if (this.dashboard) {
            this.dashboard.incrementMessage(
              "EXPLORE",
              `Downloaded Smithsonian model "${doneState.title}" (${doneState.totalMB} MB)`
            );
          }
          if (this.io) {
            if (this.cachedAssets) {
              this.io.emit("hologram-asset-list", this.cachedAssets);
              this.io.emit("message", `SendingAssets#${JSON.stringify(this.cachedAssets)}`);
            }
            this.io.emit("explore-download-complete", doneState);
          }
        },
        onError: (errState) => {
          if (this.dashboard) {
            this.dashboard.log("ERROR", `Explore download failed for "${errState.title}": ${errState.error}`);
          }
          if (this.io) {
            this.io.emit("explore-download-error", errState);
          }
        }
      })
      .catch(() => {});
  }

  getWebConnectUrl() {
    const webBase = "https://cuenect-offline.netlify.app/";
    if (this.publicTunnelUrl) {
      const socketUrl = this.publicTunnelUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
      return `${webBase}?server=${encodeURIComponent(socketUrl)}`;
    }
    const localIp = this.host || getMachineIPAddresses(this.host)[0] || "127.0.0.1";
    return `${webBase}?host=${localIp}&port=${this.port}&usePort=true`;
  }

  loadLocalAssetDatabase() {
    try {
      const candidateDbPaths = this.getCandidateDbPaths();

      for (const dbPath of candidateDbPaths) {
        if (fs.existsSync(dbPath)) {
          const raw = fs.readFileSync(dbPath, "utf-8");
          if (raw && raw.trim()) {
            const parsed = JSON.parse(raw);
            this.cachedAssets = enrichAssetCatalog(parsed);
            this.refreshExistingSmithsonianMetadata();
            return;
          }
        }
      }

      // Fallback: discover only existing models in StreamingAssets or candidate dirs
      const streamingAssets = "C:\\Unity\\Kayunet\\Assets\\StreamingAssets";
      let existingFiles = [];
      if (fs.existsSync(streamingAssets)) {
        try {
          existingFiles = fs.readdirSync(streamingAssets).filter((f) => f.toLowerCase().endsWith(".glb"));
        } catch {}
      }

      if (existingFiles.length > 0) {
        const generated = {
          assetinformation: existingFiles.map((file) => {
            const id = path.basename(file, ".glb");
            const cleanName = id.replace(/^\d+_/, "").replace(/_/g, " ");
            return {
              AssetID: id,
              AssetName: cleanName,
              PlaylistName: "Clothing & Wearables",
              ThumbnailImagePath: "#",
              ModelPath: path.join(streamingAssets, file),
              Category: 0
            };
          })
        };
        this.cachedAssets = enrichAssetCatalog(generated);
        return;
      }
    } catch (e) {}
  }

  async refreshExistingSmithsonianMetadata() {
    try {
      const list = this.cachedAssets?.assetinformation;
      if (!Array.isArray(list) || list.length === 0) return;

      let updatedAny = false;
      for (const asset of list) {
        if (!asset) continue;
        if (asset.metadata && typeof asset.metadata.description === "string") {
          if (/^3D digitized artifact from the /i.test(asset.metadata.description.trim())) {
            asset.metadata.description = "";
            updatedAny = true;
          }
        }
        if (!asset.smithsonianId) continue;
        const freshMeta = await this.exploreManager.fetchMetadataForPackage(
          asset.smithsonianId,
          asset.AssetName
        );
        if (freshMeta) {
          asset.metadata = freshMeta;
          updatedAny = true;
        }
      }

      if (updatedAny) {
        this.saveAssetToDatabase(list[0]);
        if (this.io) {
          this.io.emit("hologram-asset-list", this.cachedAssets);
          this.io.emit("message", `SendingAssets#${JSON.stringify(this.cachedAssets)}`);
        }
      }
    } catch {}
  }

  setDashboard(dashboard) {
    this.dashboard = dashboard;
  }

  setPublicTunnelUrl(url) {
    this.publicTunnelUrl = url;
    if (this.dashboard) {
      this.dashboard.setPublicUrl(url);
    }
    const connectUrl = this.getWebConnectUrl();
    if (this.io) {
      this.io.emit("qr-code", { action: "show", url: connectUrl });
      this.io.emit("message", `QRCodeURL#${connectUrl}`);
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      // 1. Create HTTP server for health check & stats & model streaming
      this.httpServer = http.createServer((req, res) => {
        const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        const pathname = parsedUrl.pathname;
        const query = parsedUrl.searchParams;

        // Enable CORS
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range, ngrok-skip-browser-warning, Authorization, X-Requested-With, If-None-Match, If-Modified-Since, *");
        res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, ETag, Last-Modified, Cache-Control, *");
        res.setHeader("Access-Control-Max-Age", "86400");

        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Range, ngrok-skip-browser-warning, Authorization, X-Requested-With, If-None-Match, If-Modified-Since, *",
            "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, ETag, Last-Modified, Cache-Control, *",
            "Access-Control-Max-Age": "86400"
          });
          res.end();
          return;
        }

        if (pathname === "/health" || pathname === "/status") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "healthy",
              protocol: "socket.io",
              port: this.port,
              activeConnections: this.activeSocketIOUsers.size,
              stagesCount: this.stages.size,
              onlineStages: Array.from(this.stages.values()).filter((s) => s.online).length,
              uptimeSeconds: Math.round(process.uptime()),
              publicUrl: this.publicTunnelUrl || null,
              localIp: this.host || getMachineIPAddresses(this.host)[0] || "127.0.0.1"
            })
          );
          return;
        }

        if (pathname === "/api/stages" || pathname === "/stages") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ stages: this.getStageRoster() }));
          return;
        }

        // Static favicon and icon endpoints
        if (
          pathname === "/favicon.ico" ||
          pathname === "/favicon.png" ||
          pathname === "/favicon-32x32.png" ||
          pathname === "/favicon-16x16.png" ||
          pathname === "/favicon.svg" ||
          pathname === "/logo.png" ||
          pathname === "/icon-192.png" ||
          pathname === "/icon-512.png" ||
          pathname === "/apple-touch-icon.png"
        ) {
          const publicDir = path.join(__dirname, "..", "public");
          const fileName = pathname.slice(1);
          const filePath = path.join(publicDir, fileName);
          if (fs.existsSync(filePath)) {
            const ext = path.extname(fileName).toLowerCase();
            const mimeTypes = {
              ".ico": "image/x-icon",
              ".png": "image/png",
              ".svg": "image/svg+xml"
            };
            res.writeHead(200, {
              "Content-Type": mimeTypes[ext] || "image/png",
              "Cache-Control": "public, max-age=86400"
            });
            fs.createReadStream(filePath).pipe(res);
            return;
          }
        }

        if (pathname === "/api/connection-info") {
          const ips = getMachineIPAddresses(this.host);
          const localIp = this.host || ips[0] || "127.0.0.1";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              localIp,
              localIps: ips,
              port: this.port,
              protocol: "http",
              localUrl: `http://${localIp}:${this.port}`,
              publicUrl: this.publicTunnelUrl || null,
              isTunnel: Boolean(this.publicTunnelUrl)
            })
          );
          return;
        }

        if (pathname === "/api/explore/models" && req.method === "GET") {
          const searchQ = query.get("q") || "";
          const count = Math.min(20, Math.max(1, parseInt(query.get("count") || "10", 10) || 10));
          const existingAssets = this.cachedAssets?.assetinformation || [];

          this.exploreManager
            .fetchExploreModels({ query: searchQ, count, existingAssets })
            .then((result) => {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: true,
                  count: Array.isArray(result?.models) ? result.models.length : 0,
                  ...result,
                  offline: false
                })
              );
            })
            .catch((err) => {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: false,
                  models: [],
                  offline: true,
                  message: (err.message || "Unable to reach Smithsonian 3D").replace(/\s*API\b/gi, ""),
                  error: (err.message || "Unable to reach Smithsonian 3D").replace(/\s*API\b/gi, ""),
                  activeDownloads: this.exploreManager.getActiveDownloadsSnapshot()
                })
              );
            });
          return;
        }

        if (pathname === "/api/explore/downloads" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              downloads: this.exploreManager.getActiveDownloadsSnapshot()
            })
          );
          return;
        }

        if (pathname === "/api/explore/download" && req.method === "POST") {
          const chunks = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
              const model = body.model || body;
              const initiator = body.initiator || "web";
              const modelId = model?.smithsonianId || model?.id;
              if (!model || !modelId || !model.modelUrl) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "Missing model.smithsonianId/id or model.modelUrl" }));
                return;
              }
              model.id = modelId;
              model.smithsonianId = modelId;
              this.triggerExploreDownload(model, initiator);
              res.writeHead(202, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: true,
                  status: "started",
                  id: modelId,
                  smithsonianId: modelId,
                  downloads: this.exploreManager.getActiveDownloadsSnapshot()
                })
              );
            } catch (err) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: err.message || "Invalid JSON body" }));
            }
          });
          return;
        }

        if (pathname === "/api/model-info") {
          const modelParam = query.get("path") || query.get("file") || "";
          if (!modelParam) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing 'path' or 'file' query parameter" }));
            return;
          }
          const info = inspectGlb(modelParam);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(info));
          return;
        }

        if (pathname === "/api/model") {
          const modelParam = query.get("path") || query.get("file") || "";
          if (!modelParam) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing 'path' or 'file' query parameter" }));
            return;
          }

          const info = inspectGlb(modelParam);
          if (!info.exists || !info.resolvedPath) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Model file not found on server", info }));
            return;
          }

          const force = query.get("force") === "true";
          if (!info.isLoadable && !force) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "Model exceeds web preview size or polycount threshold",
                rejectionReason: info.rejectionReason,
                fileSizeMB: info.fileSizeMB,
                triangleCount: info.triangleCount
              })
            );
            return;
          }

          const resolvedFile = info.resolvedPath;
          let stat;
          try {
            stat = fs.statSync(resolvedFile);
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Failed to stat file: ${err.message}` }));
            return;
          }

          const fileSize = stat.size;
          const etag = `W/"${fileSize}-${Math.floor(stat.mtimeMs)}"`;
          const lastModified = stat.mtime.toUTCString();
          const cacheControl = "public, max-age=604800, stale-while-revalidate=86400";

          // Conditional GET check for 304 Not Modified
          const ifNoneMatch = req.headers["if-none-match"];
          const ifModifiedSince = req.headers["if-modified-since"];
          if (
            ifNoneMatch === etag ||
            (ifModifiedSince && new Date(ifModifiedSince) >= stat.mtime)
          ) {
            res.writeHead(304, {
              "ETag": etag,
              "Last-Modified": lastModified,
              "Cache-Control": cacheControl
            });
            res.end();
            return;
          }

          const range = req.headers.range;

          if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            if (start >= fileSize || end >= fileSize) {
              res.writeHead(416, {
                "Content-Range": `bytes */${fileSize}`,
                "Cache-Control": cacheControl,
                "ETag": etag
              });
              res.end();
              return;
            }

            const chunksize = end - start + 1;
            const fileStream = fs.createReadStream(resolvedFile, { start, end });
            res.writeHead(206, {
              "Content-Range": `bytes ${start}-${end}/${fileSize}`,
              "Accept-Ranges": "bytes",
              "Content-Length": chunksize,
              "Content-Type": "model/gltf-binary",
              "Cache-Control": cacheControl,
              "ETag": etag,
              "Last-Modified": lastModified
            });
            fileStream.pipe(res);
          } else {
            res.writeHead(200, {
              "Content-Length": fileSize,
              "Accept-Ranges": "bytes",
              "Content-Type": "model/gltf-binary",
              "Cache-Control": cacheControl,
              "ETag": etag,
              "Last-Modified": lastModified
            });
            if (req.method === "HEAD") {
              res.end();
            } else {
              fs.createReadStream(resolvedFile).pipe(res);
            }
          }
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Cuenect Hologram Stage Bridge</title>
            <link rel="icon" type="image/x-icon" href="/favicon.ico">
            <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
            <link rel="apple-touch-icon" href="/apple-touch-icon.png">
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #070a13; color: #fff; text-align: center; padding: 40px 20px; }
              .card { background: #0d1222; border: 1px solid #1f2d4d; border-radius: 16px; max-width: 480px; margin: 0 auto; padding: 32px 24px; box-shadow: 0 12px 40px rgba(0,0,0,0.6); }
              .logo { width: 84px; height: 84px; margin-bottom: 8px; filter: drop-shadow(0 0 16px rgba(0, 229, 255, 0.5)); }
              h1 { color: #00e5ff; font-size: 1.4rem; margin: 8px 0 12px 0; letter-spacing: 0.05em; }
              .badge { display: inline-block; padding: 4px 14px; border-radius: 20px; background: rgba(34, 197, 94, 0.15); color: #22c55e; font-weight: 600; font-size: 0.85rem; }
              .info { text-align: left; background: #05070e; padding: 14px; border-radius: 10px; margin-top: 20px; font-family: monospace; font-size: 0.85rem; color: #94a3b8; border: 1px solid #162035; }
            </style>
          </head>
          <body>
            <div class="card">
              <img src="/favicon.png" alt="Cuenect Hologram Stage" class="logo" />
              <h1>CUENECT STAGE BRIDGE</h1>
              <div class="badge">● Online (Port ${this.port})</div>
              <div class="info">
                Active Connections: ${this.activeSocketIOUsers.size}<br>
                Uptime: ${Math.round(process.uptime())}s<br>
                Local URL: http://${this.host || getMachineIPAddresses(this.host)[0]}:${this.port}
                ${this.publicTunnelUrl ? `<br>Public URL: ${this.publicTunnelUrl}` : ""}
              </div>
            </div>
          </body>
          </html>
        `);
      });

      // 2. Attach Socket.IO Server (sole transport — Unity and the web/mobile
      // controllers all speak Socket.IO exclusively; there is no raw-WebSocket fallback)
      this.io = new SocketIOServer(this.httpServer, {
        cors: {
          origin: "*",
          methods: ["GET", "POST"]
        },
        pingTimeout: 30000,
        pingInterval: 20000,
        allowEIO3: true
      });

      this.setupSocketIOEvents();

      this.httpServer.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          const friendlyError = `Port ${this.port} is already in use by another application or server instance.`;
          if (this.dashboard) {
            this.dashboard.setAlert("error", "PORT IN USE", `${friendlyError} Run 'taskkill /F /IM cuenect-server.exe' or start with --port <other_port>.`);
          }
          reject(new Error(friendlyError));
        } else {
          if (this.dashboard) {
            this.dashboard.setAlert("error", "SERVER ERROR", err.message);
          }
          reject(err);
        }
      });

      this.httpServer.listen(this.port, () => {
        resolve();
      });
    });
  }

  /**
   * A single operator should never have to ask themselves for permission.
   * If exactly one controller is connected, it owns the stage - this also
   * recovers the common case of reloading the page while a stale socket from
   * the previous session still holds the lock.
   */
  claimIfSoleController() {
    const controllers = [];
    for (const [id, role] of this.roles.entries()) {
      if (role === "controller") controllers.push(id);
    }
    if (controllers.length === 1) {
      this.controlHolder = controllers[0];
    }
  }

  /**
   * Hand control to any remaining controller so the stage is never left
   * unowned while an operator is connected.
   */
  promoteNextController() {
    for (const [id, role] of this.roles.entries()) {
      if (role === "controller") {
        this.controlHolder = id;
        return;
      }
    }
  }

  /**
   * Tell every client who holds control. Each socket receives its own view so
   * the client does not have to know its own socket id.
   */
  broadcastControlState() {
    const holderName = this.controlHolder
      ? this.activeSocketIOUsers.get(this.controlHolder) || null
      : null;

    const operators = [];
    for (const [id, role] of this.roles.entries()) {
      if (role !== "controller") continue;
      operators.push({
        name: this.activeSocketIOUsers.get(id) || "operator",
        hasControl: id === this.controlHolder
      });
    }

    for (const [id] of this.roles.entries()) {
      const target = this.io.sockets.sockets.get(id);
      if (!target) continue;
      target.emit("control-lock-state", {
        holderName,
        youHaveControl: id === this.controlHolder,
        locked: this.controlHolder !== null,
        operators
      });
    }
  }

  /**
   * Get serialized array of all registered stages and their state.
   */
  getStageRoster() {
    return Array.from(this.stages.values()).map((s) => ({
      stageId: s.stageId,
      displayName: s.displayName,
      group: s.group || "Default",
      online: Boolean(s.online),
      currentModel: s.currentModel || null,
      displayMode: s.displayMode || "2D",
      lastSeen: s.lastSeen || Date.now()
    }));
  }

  /**
   * Broadcast current stage roster to all connected sockets.
   */
  broadcastStageRoster() {
    if (!this.io) return;
    const roster = this.getStageRoster();
    this.io.emit("stage-roster-update", { stages: roster });
  }

  /**
   * Register or update a Unity stage node with unique stageId, name, and group.
   */
  registerStage(socket, payload = {}) {
    const systemId = payload.systemId ? String(payload.systemId).trim() : null;
    let stageId = (payload.stageId && payload.stageId !== "stage_01") ? String(payload.stageId).trim() : null;
    let displayName = (payload.displayName && payload.displayName !== "Stage 01") ? String(payload.displayName).trim() : null;
    let group = payload.group ? String(payload.group).trim() : "Default";

    // 1. If this physical machine (systemId) is already registered, reuse its persistent identity
    if (systemId && this.systemToStage.has(systemId)) {
      const stored = this.systemToStage.get(systemId);
      stageId = stageId || stored.stageId;
      displayName = displayName || stored.displayName;
      group = (group && group !== "Default") ? group : (stored.group || "Default");
    }

    // 2. If payload has explicit stageId (e.g. from stage_config.json or CLI flags), use it
    if (!stageId && payload.stageId && payload.stageId.trim().length > 0) {
      stageId = payload.stageId.trim();
    }

    // 3. If still unassigned, generate the next sequential stage ID and display name
    if (!stageId) {
      let counter = 1;
      while (true) {
        const candidate = `stage_${String(counter).padStart(2, "0")}`;
        const inUseByOther = Array.from(this.systemToStage.entries()).some(
          ([sys, data]) => data.stageId === candidate && sys !== systemId
        );
        if (!inUseByOther) {
          stageId = candidate;
          if (!displayName) {
            displayName = `Stage ${String(counter).padStart(2, "0")}`;
          }
          break;
        }
        counter++;
      }
    }

    if (!displayName) {
      displayName = `Stage ${stageId}`;
    }

    // 4. Save persistent mapping for this hardware systemId
    if (systemId) {
      this.systemToStage.set(systemId, { stageId, displayName, group });
      this.saveSystemRegistry();
    }

    // Clean up previous mapping if this socket had a different stageId
    const prevStageId = this.socketToStageId.get(socket.id);
    if (prevStageId && prevStageId !== stageId && this.stages.has(prevStageId)) {
      const prevInfo = this.stages.get(prevStageId);
      prevInfo.online = false;
      prevInfo.socketId = null;
    }

    this.roles.set(socket.id, "stage");
    this.socketToStageId.set(socket.id, stageId);
    this.activeSocketIOUsers.set(socket.id, displayName);

    // Join Socket.IO rooms for targeted multicast & broadcast
    socket.join(`stage:${stageId}`);
    socket.join("stages:all");
    if (group) {
      socket.join(`group:${group}`);
    }

    const existing = this.stages.get(stageId) || {};
    const stageInfo = {
      ...existing,
      stageId,
      socketId: socket.id,
      displayName,
      group,
      systemId: systemId || existing.systemId || null,
      online: true,
      currentModel: payload.currentModel !== undefined ? payload.currentModel : (existing.currentModel || null),
      displayMode: payload.displayMode !== undefined ? payload.displayMode : (existing.displayMode || "2D"),
      lastSeen: Date.now()
    };

    this.stages.set(stageId, stageInfo);

    if (this.dashboard) {
      this.dashboard.incrementMessage("STAGE", `Stage "${stageInfo.displayName}" (${stageId}) online in [${stageInfo.group}]`);
    }

    // Acknowledge registration to the stage with assigned identity
    socket.emit("stage-registered", {
      success: true,
      stageId,
      displayName: stageInfo.displayName,
      group: stageInfo.group,
      systemId
    });

    // Deliver QR code / connection info to stage
    const connectUrl = this.getWebConnectUrl();
    socket.emit("qr-code", { action: "show", url: connectUrl });
    socket.emit("message", `QRCodeURL#${connectUrl}`);

    // Broadcast updated roster to all controllers & stages
    this.broadcastStageRoster();
    return stageInfo;
  }

  /**
   * Update active model, display mode, or metadata for a registered stage.
   */
  updateStageState(socket, payload = {}) {
    const stageId = this.socketToStageId.get(socket.id) || payload.stageId;
    if (!stageId || !this.stages.has(stageId)) return;

    const info = this.stages.get(stageId);
    if (payload.currentModel !== undefined) info.currentModel = payload.currentModel;
    if (payload.displayMode !== undefined) info.displayMode = payload.displayMode;
    if (payload.displayName !== undefined) info.displayName = payload.displayName;
    if (payload.group !== undefined) info.group = payload.group;
    info.lastSeen = Date.now();

    if (this.dashboard && payload.currentModel !== undefined) {
      this.dashboard.incrementMessage("STAGE", `Stage "${info.displayName}" model: ${payload.currentModel || "none"}`);
    }

    this.broadcastStageRoster();
  }

  /**
   * Dispatch a targeted command to one, many, or all stages.
   */
  dispatchTargetedCommand(socket, envelope = {}) {
    if (!envelope || typeof envelope !== "object") return;
    const { targets, targetEvent, event, data } = envelope;
    const eventName = targetEvent || event;
    if (!eventName || typeof eventName !== "string") return;

    if (!RELAYABLE_EVENTS.has(eventName)) {
      if (this.dashboard) {
        this.dashboard.log("WARN", `Dropped non-allowlisted dispatched event: "${eventName}"`);
      }
      return;
    }

    // Merge incoming catalog if asset list is being forwarded
    if (eventName === "hologram-asset-list" && data) {
      this.cachedAssets = this.mergeIncomingStageCatalog(data);
    }

    // Broadcast to ALL stages if targets is "*", "all", or unspecified
    const isBroadcast =
      !targets ||
      targets === "*" ||
      targets === "all" ||
      (Array.isArray(targets) && (targets.includes("*") || targets.includes("all")));

    if (isBroadcast) {
      this.io.to("stages:all").emit(eventName, data);
      if (this.dashboard) {
        this.dashboard.incrementMessage("DISPATCH", `Broadcast "${eventName}" to all stages`);
      }
      return;
    }

    // Multicast to targeted stage IDs or group names
    const targetList = Array.isArray(targets) ? targets : [targets];
    let broadcaster = this.io;
    for (const t of targetList) {
      if (!t || typeof t !== "string") continue;
      const trimmed = t.trim();
      if (trimmed.startsWith("stage:") || trimmed.startsWith("group:")) {
        broadcaster = broadcaster.to(trimmed);
      } else {
        broadcaster = broadcaster.to(`stage:${trimmed}`);
      }
    }
    broadcaster.emit(eventName, data);

    if (this.dashboard) {
      this.dashboard.incrementMessage("DISPATCH", `Routed "${eventName}" to [${targetList.join(", ")}]`);
    }
  }

  setupSocketIOEvents() {
    this.io.on("connection", (socket) => {
      const clientIp = socket.handshake.address || "127.0.0.1";
      const shortId = socket.id.substring(0, 5);
      const defaultName = `Client_${shortId}`;
      this.activeSocketIOUsers.set(socket.id, defaultName);
      this.roles.set(socket.id, "controller");
      if (this.dashboard) {
        this.dashboard.addUser(defaultName);
      }

      // ── Multi-Stage Orchestration Listeners ─────────────────────────────
      socket.on("stage-register", (payload) => {
        this.registerStage(socket, payload);
      });

      socket.on("stage-state-update", (payload) => {
        this.updateStageState(socket, payload);
      });

      socket.on("dispatch-command", (envelope) => {
        this.dispatchTargetedCommand(socket, envelope);
      });

      socket.on("get-stages-roster", (callback) => {
        const roster = this.getStageRoster();
        if (typeof callback === "function") {
          callback({ stages: roster });
        } else {
          socket.emit("stage-roster-update", { stages: roster });
        }
      });
      // ────────────────────────────────────────────────────────────────────

      socket.on("login", (data) => {
        const username = (typeof data === "string" ? data : (data && data.name)) || defaultName;
        const secret = (typeof data === "object" && data) ? data.secret : undefined;
        const role = (secret === this.stageSecret || username === "Unity_Stage" || (data && data.role === "stage")) ? "stage" : "controller";
        this.roles.set(socket.id, role);

        if (this.dashboard && this.activeSocketIOUsers.has(socket.id)) {
          this.dashboard.removeUser(this.activeSocketIOUsers.get(socket.id));
        }
        this.activeSocketIOUsers.set(socket.id, username);

        if (this.dashboard) {
          this.dashboard.addUser(username);
        }

        const localIps = getMachineIPAddresses(this.host);
        const primaryLocalIp = this.host || localIps[0] || "127.0.0.1";
        const stageRoster = this.getStageRoster();

        socket.emit("login_response", {
          success: true,
          users: Array.from(this.activeSocketIOUsers.values()),
          stages: stageRoster,
          serverInfo: {
            localIp: primaryLocalIp,
            localIps: localIps,
            port: this.port,
            localUrl: `http://${primaryLocalIp}:${this.port}`,
            publicUrl: this.publicTunnelUrl || null,
            isTunnel: Boolean(this.publicTunnelUrl)
          }
        });

        socket.broadcast.emit("user_joined", {
          user: username,
          users: Array.from(this.activeSocketIOUsers.values())
        });

        // First controller in owns the stage; later ones join as observers until
        // they explicitly request control.
        if (role === "controller" && this.controlHolder === null) {
          this.controlHolder = socket.id;
        }
        this.claimIfSoleController();
        this.broadcastControlState();

        // Deliver catalog and stage roster to controller sockets
        if (role === "controller") {
          socket.emit("stage-roster-update", { stages: stageRoster });
          if (this.cachedAssets) {
            socket.emit("hologram-asset-list", this.cachedAssets);
            const assetStr = typeof this.cachedAssets === "string" ? this.cachedAssets : JSON.stringify(this.cachedAssets);
            socket.emit("message", `SendingAssets#${assetStr}`);
          }
        }

        // Auto-register legacy or new stage logins
        if (role === "stage") {
          const stageId = (data && data.stageId) ? String(data.stageId).trim() : (username === "Unity_Stage" ? `stage_${shortId}` : username);
          const displayName = (data && data.displayName) ? String(data.displayName).trim() : (username === "Unity_Stage" ? `Stage ${shortId}` : username);
          const group = (data && data.group) ? String(data.group).trim() : "Default";
          this.registerStage(socket, {
            stageId,
            displayName,
            group,
            currentModel: data?.currentModel,
            displayMode: data?.displayMode
          });
        }
      });

      // Control ownership: a single operator drives the stage at a time so two
      // controllers cannot fight over the same model during a live show.
      socket.on("control-request", () => {
        if (this.roles.get(socket.id) !== "controller") return;
        const previous = this.controlHolder;
        this.controlHolder = socket.id;
        if (this.dashboard) {
          this.dashboard.incrementMessage(
            "CONTROL",
            `${this.activeSocketIOUsers.get(socket.id) || "operator"} took control` +
              (previous && previous !== socket.id ? " (was " + (this.activeSocketIOUsers.get(previous) || "another operator") + ")" : "")
          );
        }
        this.broadcastControlState();
      });

      socket.on("control-release", () => {
        if (this.controlHolder !== socket.id) return;
        this.controlHolder = null;
        if (this.dashboard) {
          this.dashboard.incrementMessage("CONTROL", `${this.activeSocketIOUsers.get(socket.id) || "operator"} released control`);
        }
        this.broadcastControlState();
      });

      socket.on("explore-download-start", (payload) => {
        const model = payload?.model || payload;
        const initiator = payload?.initiator || (this.roles.get(socket.id) === "stage" ? "unity" : "web");
        const modelId = model?.smithsonianId || model?.id;
        if (model && modelId && model.modelUrl) {
          model.id = modelId;
          model.smithsonianId = modelId;
          this.triggerExploreDownload(model, initiator);
        }
      });

      // Relay only allowed stage events
      socket.onAny((eventName, ...args) => {
        if (
          eventName === "explore-download-start" ||
          eventName === "stage-register" ||
          eventName === "stage-state-update" ||
          eventName === "dispatch-command" ||
          eventName === "get-stages-roster" ||
          eventName === "stage-registered" ||
          eventName === "stage-roster-update"
        ) {
          return;
        }
        if (!RELAYABLE_EVENTS.has(eventName)) {
          if (eventName !== "login" && eventName !== "disconnect") {
            if (this.dashboard) this.dashboard.log("WARN", `Dropped non-allowlisted event: "${eventName}"`);
          }
          return;
        }

        const isStage = this.roles.get(socket.id) === "stage";

        if (isStage && eventName === "hologram-asset-list") {
          this.cachedAssets = this.mergeIncomingStageCatalog(args[0]);
          args[0] = this.cachedAssets;
        } else if (isStage && eventName === "message" && typeof args[0] === "string" && args[0].startsWith("SendingAssets#")) {
          try {
            const jsonPart = args[0].substring(args[0].indexOf("#") + 1);
            this.cachedAssets = this.mergeIncomingStageCatalog(JSON.parse(jsonPart));
            args[0] = `SendingAssets#${JSON.stringify(this.cachedAssets)}`;
          } catch {}
        } else if (!isStage && eventName === "message" && typeof args[0] === "string") {
          if (args[0].startsWith("ReqAsset")) {
            this.loadLocalAssetDatabase();
            if (this.cachedAssets) {
              socket.emit("hologram-asset-list", this.cachedAssets);
              socket.emit("message", `SendingAssets#${JSON.stringify(this.cachedAssets)}`);
            }
          } else if (args[0].startsWith("ModelImageRequest#")) {
            const assetId = args[0].substring(args[0].indexOf("#") + 1).trim();
            const list = this.cachedAssets?.assetinformation || [];
            const found = list.find((a) => a && a.AssetID === assetId);
            if (found && found.ThumbnailImagePath && found.ThumbnailImagePath !== "#" && fs.existsSync(found.ThumbnailImagePath)) {
              try {
                const ext = path.extname(found.ThumbnailImagePath).toLowerCase();
                const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
                const b64 = fs.readFileSync(found.ThumbnailImagePath).toString("base64");
                socket.emit("message", `ModelImageReceving#${assetId}#data:${mime};base64,${b64}`);
              } catch {}
            }
          }
        }

        // Categorize event for friendly dashboard display
        if (this.dashboard) {
          const payload = args[0] || {};
          switch (eventName) {
            case "hologram-asset-action": {
              const name = payload.title || payload.name || payload.AssetName || "3D Asset";
              this.dashboard.incrementMessage("ASSET", `Displaying asset "${name}"`);
              break;
            }
            case "hologram-model-action": {
              this.dashboard.incrementMessage("MODEL", `Control: ${payload.action || "snap"}`);
              break;
            }
            case "hologram-joystick-action": {
              const now = Date.now();
              if (!this.lastJoystickLog || now - this.lastJoystickLog > 1000) {
                this.lastJoystickLog = now;
                this.dashboard.incrementMessage("JOYSTICK", "D-Pad motion active");
              } else {
                this.dashboard.incrementMessage();
              }
              break;
            }
            case "hologram-video-action": {
              this.dashboard.incrementMessage("VIDEO", "Video playback control packet");
              break;
            }
            case "hologram-action": {
              this.dashboard.incrementMessage("MODE", `Movable mode: ${payload.action || "rotate"}`);
              break;
            }
            case "StereoSettingsActionKey": {
              this.dashboard.incrementMessage("STEREO", `SBS optical calibration (IPD: ${payload.ipd || 0.065})`);
              break;
            }
            case "hologram-camera-orthographic-action": {
              this.dashboard.incrementMessage("CAMERA", `Orthographic toggle: ${payload.isOrthographic}`);
              break;
            }
            case "hologram-display-mode-action": {
              const modeLabels = ["2D", "Stereoscopic (SBS)", "HOLO Stereoscopic", "KMAX Stereoscopic"];
              const label = payload.modeName || modeLabels[payload.mode] || "unknown";
              this.dashboard.incrementMessage("DISPLAY", `Display mode: ${label}`);
              break;
            }
            case "hologram-default-display-mode-action": {
              const modeLabels = ["2D", "Stereoscopic (SBS)", "HOLO Stereoscopic", "KMAX Stereoscopic"];
              const label = payload.modeName || modeLabels[payload.mode] || "unknown";
              this.dashboard.incrementMessage("DEFAULT_DISPLAY", `Default display mode: ${label}`);
              break;
            }
            case "hologram-environment-action": {
              const presetLabels = ["Void (black)", "Space"];
              const label = payload.presetName || presetLabels[payload.preset] || "unknown";
              this.dashboard.incrementMessage("ENV", `Stage environment: ${label}`);
              break;
            }
            case "hologram-model-transform": {
              const now = Date.now();
              if (!this.lastTransformLog || now - this.lastTransformLog > 1000) {
                this.lastTransformLog = now;
                this.dashboard.incrementMessage("TRANSFORM", `Pose: yaw=${Math.round(payload.yaw || 0)}° pitch=${Math.round(payload.pitch || 0)}° scale=${(payload.scale || 1).toFixed(2)}`);
              } else {
                this.dashboard.incrementMessage();
              }
              break;
            }
            case "message":
            case "ping":
            case "pong": {
              this.dashboard.incrementMessage();
              break;
            }
            default:
              this.dashboard.incrementMessage("RELAY", `Event: "${eventName}"`);
              break;
          }
        }

        // Broadcast to all other Socket.IO clients
        socket.broadcast.emit(eventName, ...args);
      });

      socket.on("error", (err) => {
        if (this.dashboard) {
          this.dashboard.log("ERROR", `Socket error (${shortId}): ${err.message || err}`);
        }
      });

      socket.on("disconnect", (reason) => {
        const username = this.activeSocketIOUsers.get(socket.id);
        this.activeSocketIOUsers.delete(socket.id);
        this.roles.delete(socket.id);

        // Stage disconnection handling
        const stageId = this.socketToStageId.get(socket.id);
        if (stageId) {
          this.socketToStageId.delete(socket.id);
          if (this.stages.has(stageId)) {
            const info = this.stages.get(stageId);
            info.online = false;
            info.socketId = null;
            info.lastSeen = Date.now();
            this.broadcastStageRoster();
            if (this.dashboard) {
              this.dashboard.incrementMessage("STAGE", `Stage "${info.displayName}" (${stageId}) disconnected`);
            }
          }
        }

        // Never leave the stage locked to a socket that is gone.
        if (this.controlHolder === socket.id) {
          this.controlHolder = null;
          this.promoteNextController();
        }
        this.claimIfSoleController();
        this.broadcastControlState();

        if (this.dashboard && username) {
          this.dashboard.removeUser(username);
        }

        if (username) {
          socket.broadcast.emit("user_left", {
            user: username,
            users: Array.from(this.activeSocketIOUsers.values())
          });
        }
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      let pending = 0;
      const checkDone = () => {
        pending--;
        if (pending <= 0) resolve();
      };

      if (this.io) {
        pending++;
        this.io.close(() => checkDone());
        this.io = null;
      }

      if (this.httpServer) {
        pending++;
        this.httpServer.close(() => checkDone());
        this.httpServer = null;
      }

      if (pending === 0) {
        resolve();
      }
    });
  }
}

module.exports = {
  SignalingServer
};
