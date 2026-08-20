const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { Server: SocketIOServer } = require("socket.io");
const { getMachineIPAddresses } = require("./network");

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
  "hologram-asset-list",
  "hologram-asset-progress",
  "qr-code",
  "socket-disconnect",
  "message",
  "stage-message"
]);

class SignalingServer {
  constructor(port = 9000) {
    this.port = port;
    this.httpServer = null;
    this.io = null;
    this.publicTunnelUrl = null;
    this.activeSocketIOUsers = new Map();
    this.roles = new Map();
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
    const localIp = getMachineIPAddresses()[0] || "127.0.0.1";
    return `${webBase}?host=${localIp}&port=${this.port}&usePort=true`;
  }

  loadLocalAssetDatabase() {
    try {
      const userProfile = process.env.USERPROFILE || process.env.HOME || "";
      const dbPath = path.join(userProfile, "Documents", "Cuenect", "CuenectDatabase.json");
      if (fs.existsSync(dbPath)) {
        const raw = fs.readFileSync(dbPath, "utf-8");
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          this.cachedAssets = parsed;
          return;
        }
      }

      // Default fallback assets list for the 10 fixed clothing models
      const defaultModels = [
        { id: "1_Leather_Jacket", name: "Leather Jacket", file: "1_Leather_Jacket.glb" },
        { id: "2_Materials_Variants_Shoe", name: "Materials Variants Shoe", file: "2_Materials_Variants_Shoe.glb" },
        { id: "3_ReadyPlayerMe_Outfit", name: "ReadyPlayerMe Outfit", file: "3_ReadyPlayerMe_Outfit.glb" },
        { id: "4_Vintage_Corset", name: "Vintage Corset", file: "4_Vintage_Corset.glb" },
        { id: "5_Chronograph_Luxury_Watch", name: "Chronograph Luxury Watch", file: "5_Chronograph_Luxury_Watch.glb" },
        { id: "6_Designer_Sunglasses", name: "Designer Sunglasses", file: "6_Designer_Sunglasses.glb" },
        { id: "7_Michelle_Casual_Wear", name: "Michelle Casual Wear", file: "7_Michelle_Casual_Wear.glb" },
        { id: "8_Venice_Carnival_Mask", name: "Venice Carnival Mask", file: "8_Venice_Carnival_Mask.glb" },
        { id: "9_Military_Uniform_Soldier", name: "Military Uniform Soldier", file: "9_Military_Uniform_Soldier.glb" },
        { id: "10_Suit_Cesium_Man", name: "Suit Cesium Man", file: "10_Suit_Cesium_Man.glb" }
      ];

      const generated = {
        assetinformation: defaultModels.map((m) => ({
          AssetID: m.id,
          AssetName: m.name,
          PlaylistName: "Clothing & Wearables",
          ThumbnailImagePath: "#",
          ModelPath: m.file,
          Category: 0
        }))
      };

      this.cachedAssets = generated;
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
      // 1. Create HTTP server for health check & stats
      this.httpServer = http.createServer((req, res) => {
        const url = req.url || "/";

        // Enable CORS
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (url === "/health" || url === "/status") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "healthy",
              protocol: "socket.io",
              port: this.port,
              activeConnections: this.activeSocketIOUsers.size,
              uptimeSeconds: Math.round(process.uptime()),
              publicUrl: this.publicTunnelUrl || null
            })
          );
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Cuenect Hologram Stage Bridge</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #fff; text-align: center; padding: 40px 20px; }
              .card { background: #131b2e; border: 1px solid #1f2d4d; border-radius: 12px; max-width: 480px; margin: 0 auto; padding: 24px; }
              h1 { color: #00e5ff; font-size: 1.4rem; margin-bottom: 8px; }
              .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; background: rgba(34, 197, 94, 0.15); color: #22c55e; font-weight: 600; font-size: 0.85rem; }
              .info { text-align: left; background: #070a12; padding: 12px; border-radius: 8px; margin-top: 16px; font-family: monospace; font-size: 0.85rem; color: #94a3b8; }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>Cuenect Hologram Stage Server</h1>
              <div class="badge">● Online (Port ${this.port})</div>
              <div class="info">
                Active Connections: ${this.activeSocketIOUsers.size}<br>
                Uptime: ${Math.round(process.uptime())}s<br>
                Local URL: http://${getMachineIPAddresses()[0]}:${this.port}
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

        socket.emit("login_response", {
          success: true,
          users: Array.from(this.activeSocketIOUsers.values())
        });

        socket.broadcast.emit("user_joined", {
          user: username,
          users: Array.from(this.activeSocketIOUsers.values())
        });

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
          this.cachedAssets = args[0];
        } else if (isStage && eventName === "message" && typeof args[0] === "string" && args[0].startsWith("SendingAssets#")) {
          try {
            const jsonPart = args[0].substring(args[0].indexOf("#") + 1);
            this.cachedAssets = JSON.parse(jsonPart);
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
              this.dashboard.incrementMessage("JOYSTICK", "D-Pad motion packet relayed");
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
              const modeLabels = ["2D", "Stereoscopic (SBS)", "HOLO Stereoscopic"];
              const label = payload.modeName || modeLabels[payload.mode] || "unknown";
              this.dashboard.incrementMessage("DISPLAY", `Display mode: ${label}`);
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
