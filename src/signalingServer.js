const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server: SocketIOServer } = require("socket.io");
const { getMachineIPAddresses } = require("./network");

class SignalingServer {
  constructor(port = 9000) {
    this.port = port;
    this.httpServer = null;
    this.io = null;
    this.publicTunnelUrl = null;
    this.activeSocketIOUsers = new Map();
    this.dashboard = null;
    this.cachedAssets = null;
    this.loadLocalAssetDatabase();
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
        }
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
      if (this.dashboard) {
        this.dashboard.addUser(defaultName);
      }

      if (this.cachedAssets) {
        socket.emit("hologram-asset-list", this.cachedAssets);
        const assetStr = typeof this.cachedAssets === "string" ? this.cachedAssets : JSON.stringify(this.cachedAssets);
        socket.emit("message", `SendingAssets#${assetStr}`);
      }

      socket.on("login", (data) => {
        const username = (typeof data === "string" ? data : (data && data.name)) || defaultName;
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

        if (this.cachedAssets) {
          socket.emit("hologram-asset-list", this.cachedAssets);
          const assetStr = typeof this.cachedAssets === "string" ? this.cachedAssets : JSON.stringify(this.cachedAssets);
          socket.emit("message", `SendingAssets#${assetStr}`);
        }
      });

      // Relay all stage events
      socket.onAny((eventName, ...args) => {
        if (eventName === "login" || eventName === "disconnect") return;

        if (eventName === "hologram-asset-list") {
          this.cachedAssets = args[0];
        } else if (eventName === "message" && typeof args[0] === "string" && args[0].startsWith("SendingAssets#")) {
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
    if (this.io) {
      this.io.close();
      this.io = null;
    }

    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }
}

module.exports = {
  SignalingServer
};
