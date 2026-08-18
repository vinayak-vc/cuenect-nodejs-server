/**
 * Cuenect Hologram Stage WebSocket & Socket.IO Signaling Bridge Server
 * Provides high-performance, non-blocking bidirectional relay between Unity Stage and Web/Mobile controllers.
 */

const { config, readSavedToken } = require("./src/config");
const { getMachineIPAddresses } = require("./src/network");
const { SignalingServer } = require("./src/signalingServer");
const { TunnelManager } = require("./src/tunnelManager");
const { Dashboard } = require("./src/dashboard");
const { disableWindowsQuickEdit } = require("./src/windowsConsole");

async function main() {
  // 0. Disable Windows Console QuickEdit mode to prevent process freeze on click/unfocus
  disableWindowsQuickEdit();

  const localIps = getMachineIPAddresses();
  const server = new SignalingServer(config.port);
  const tunnelManager = new TunnelManager();
  const dashboard = new Dashboard(config.port, localIps);

  server.setDashboard(dashboard);

  // 1. Start interactive single-screen dashboard
  dashboard.start();

  // 2. Start local WebSocket & Socket.IO server
  try {
    await server.start();
    dashboard.log("SYS", `Server bound on 0.0.0.0:${config.port} (Socket.IO + WS)`);
  } catch (err) {
    dashboard.setAlert("error", "STARTUP FAILED", err.message);
    dashboard.render();
    setTimeout(() => process.exit(1), 3000);
    return;
  }

  // 3. Start public cloud tunnel if configured
  if (config.enableNgrok) {
    const token = config.ngrokToken || readSavedToken();
    if (token) {
      dashboard.log("TUNNEL", "Initializing secure cloud tunnel...");
      try {
        const publicUrl = await tunnelManager.start(config.port, token);
        if (publicUrl) {
          server.setPublicTunnelUrl(publicUrl);
        }
      } catch (err) {
        dashboard.setAlert("warn", "TUNNEL WARNING", `Cloud tunnel could not be established: ${err.message}. Local Wi-Fi remains active.`);
      }
    }
  }

  // 4. Graceful termination handlers
  let isShuttingDown = false;
  const gracefulShutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    dashboard.log("SYS", `Received ${signal}. Shutting down cleanly...`);

    try {
      await tunnelManager.stop();
      server.stop();
      dashboard.stop();
      console.log("\n[Server] Stopped successfully.");
      process.exit(0);
    } catch (err) {
      dashboard.stop();
      console.error("[Server] Error during shutdown:", err.message);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    dashboard.setAlert("error", "UNCAUGHT ERROR", err.message || String(err));
    dashboard.log("ERROR", `Exception: ${err.message || err}`);
  });

  process.on("unhandledRejection", (reason) => {
    dashboard.setAlert("error", "UNHANDLED REJECTION", String(reason));
    dashboard.log("ERROR", `Rejection: ${String(reason)}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
