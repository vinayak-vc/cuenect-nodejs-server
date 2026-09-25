const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
const { Server: SocketIOServer } = require("socket.io");
const { getMachineIPAddresses } = require("./network");
const { inspectGlb, resolveModelFilePath } = require("./glbInspector");

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
  "control-lock-state",
  "hologram-asset-list",
  "hologram-asset-progress",
  "qr-code",
  "socket-disconnect",
  "message",
  "stage-message"
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
    // Socket id of the controller currently allowed to drive the stage. Null
    // means the stage is unclaimed and the next controller command takes it.
    this.controlHolder = null;
    this.stageSecret = crypto.randomBytes(16).toString("hex");
    this.dashboard = null;
    this.cachedAssets = null;
    this.loadLocalAssetDatabase();
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

      for (const dbPath of candidateDbPaths) {
        if (fs.existsSync(dbPath)) {
          const raw = fs.readFileSync(dbPath, "utf-8");
          if (raw && raw.trim()) {
            const parsed = JSON.parse(raw);
            this.cachedAssets = enrichAssetCatalog(parsed);
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
              uptimeSeconds: Math.round(process.uptime()),
              publicUrl: this.publicTunnelUrl || null,
              localIp: this.host || getMachineIPAddresses(this.host)[0] || "127.0.0.1"
            })
          );
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

      socket.on("login", (data) => {
        const username = (typeof data === "string" ? data : (data && data.name)) || defaultName;
        const secret = (typeof data === "object" && data) ? data.secret : undefined;
        const role = (secret === this.stageSecret || username === "Unity_Stage") ? "stage" : "controller";
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
        socket.emit("login_response", {
          success: true,
          users: Array.from(this.activeSocketIOUsers.values()),
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

        // Deliver catalog only to authenticated controller sockets
        if (role === "controller" && this.cachedAssets) {
          socket.emit("hologram-asset-list", this.cachedAssets);
          const assetStr = typeof this.cachedAssets === "string" ? this.cachedAssets : JSON.stringify(this.cachedAssets);
          socket.emit("message", `SendingAssets#${assetStr}`);
        }

        // Deliver current QR connection URL to stage
        if (role === "stage") {
          const connectUrl = this.getWebConnectUrl();
          socket.emit("qr-code", { action: "show", url: connectUrl });
          socket.emit("message", `QRCodeURL#${connectUrl}`);
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

      // Relay only allowed stage events
      socket.onAny((eventName, ...args) => {
        if (!RELAYABLE_EVENTS.has(eventName)) {
          if (eventName !== "login" && eventName !== "disconnect") {
            if (this.dashboard) this.dashboard.log("WARN", `Dropped non-allowlisted event: "${eventName}"`);
          }
          return;
        }

        const isStage = this.roles.get(socket.id) === "stage";

        if (isStage && eventName === "hologram-asset-list") {
          this.cachedAssets = enrichAssetCatalog(args[0]);
          args[0] = this.cachedAssets;
        } else if (isStage && eventName === "message" && typeof args[0] === "string" && args[0].startsWith("SendingAssets#")) {
          try {
            const jsonPart = args[0].substring(args[0].indexOf("#") + 1);
            this.cachedAssets = enrichAssetCatalog(JSON.parse(jsonPart));
            args[0] = `SendingAssets#${JSON.stringify(this.cachedAssets)}`;
          } catch {}
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
