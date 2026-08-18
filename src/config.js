const path = require("path");
const os = require("os");
const fs = require("fs");

const TOKEN_STORE_PATH = path.join(os.homedir(), ".myapp_ngrok_token");

function resolvePort(raw, source) {
  if (raw === undefined || raw === null || raw === "") return null;
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) {
    console.error(`Invalid port from ${source}: "${raw}". Must be an integer between 1 and 65535.`);
    process.exit(1);
  }
  const n = Number(str);
  if (n < 1 || n > 65535) {
    console.error(`Port out of range from ${source}: ${n}. Must be between 1 and 65535.`);
    process.exit(1);
  }
  return n;
}

// Parse simple CLI arguments cleanly with zero side-effects
function parseArgs(args = process.argv.slice(2)) {
  const config = {
    port: resolvePort(process.env.PORT, "PORT environment variable") ?? 9000,
    ngrokToken: process.env.NGROK_AUTHTOKEN || null,
    enableNgrok: false, // Default to secure local LAN mode
    saveTokenRequested: false,
    clearTokenRequested: false,
    showHelp: false,
    heartbeatInterval: 20000, // 20 seconds
    clientTimeout: 10000      // 10 seconds pong timeout
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" || arg === "-p") {
      const val = args[++i];
      if (val === undefined || val.startsWith("-")) {
        console.error("Missing port value after --port flag.");
        process.exit(1);
      }
      config.port = resolvePort(val, "--port flag");
    } else if (arg === "--token" || arg === "-t") {
      const token = args[++i];
      if (!token || token.startsWith("-")) {
        console.error("Missing token value after --token flag.");
        process.exit(1);
      }
      config.ngrokToken = token;
      config.enableNgrok = true;
      config.saveTokenRequested = true;
    } else if (arg === "--clear-token") {
      config.clearTokenRequested = true;
    } else if (arg === "--tunnel" || arg === "--ngrok") {
      config.enableNgrok = true;
    } else if (arg === "--no-ngrok" || arg === "--offline") {
      config.enableNgrok = false;
    } else if (arg === "--help" || arg === "-h") {
      config.showHelp = true;
    }
  }

  return config;
}

function applyTokenActions(config) {
  if (config.showHelp) {
    console.log(`
Cuenect WebSocket Signaling Bridge Server
Usage: node server.js [options]

Options:
  -p, --port <number>    Set local server port (default: 9000)
  -t, --token <string>   Set and save ngrok auth token for public tunnel
  --clear-token          Delete saved ngrok auth token and exit
  --tunnel, --ngrok      Enable public ngrok tunnel (default: off)
  --offline              Run purely on local LAN without cloud tunnel
  -h, --help             Show this help message
    `);
    process.exit(0);
  }

  if (config.clearTokenRequested) {
    deleteToken();
    process.exit(0);
  }

  if (config.saveTokenRequested && config.ngrokToken) {
    saveToken(config.ngrokToken);
  }
}

function saveToken(token) {
  const trimmed = (token || "").trim();
  if (!trimmed) return false;
  const tmp = `${TOKEN_STORE_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, trimmed, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, TOKEN_STORE_PATH);
    return true;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    console.error("Failed to save ngrok token:", err.message);
    return false;
  }
}

function readSavedToken() {
  try {
    if (fs.existsSync(TOKEN_STORE_PATH)) {
      const token = fs.readFileSync(TOKEN_STORE_PATH, "utf-8").trim();
      if (token.length > 0) return token;
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

function deleteToken() {
  try {
    if (fs.existsSync(TOKEN_STORE_PATH)) {
      fs.unlinkSync(TOKEN_STORE_PATH);
      console.log("Deleted saved ngrok token.");
      return true;
    }
  } catch (err) {
    console.error("Error deleting token file:", err.message);
  }
  return false;
}

module.exports = {
  config: parseArgs(),
  parseArgs,
  applyTokenActions,
  saveToken,
  readSavedToken,
  deleteToken
};
