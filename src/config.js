const path = require("path");
const os = require("os");
const fs = require("fs");

const TOKEN_STORE_PATH = path.join(os.homedir(), ".myapp_ngrok_token");

// Parse simple CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    port: parseInt(process.env.PORT, 10) || 9000,
    ngrokToken: process.env.NGROK_AUTHTOKEN || null,
    enableNgrok: true,
    heartbeatInterval: 20000, // 20 seconds
    clientTimeout: 10000      // 10 seconds pong timeout
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" || arg === "-p") {
      config.port = parseInt(args[++i], 10) || 9000;
    } else if (arg === "--token" || arg === "-t") {
      config.ngrokToken = args[++i];
    } else if (arg === "--no-ngrok" || arg === "--offline") {
      config.enableNgrok = false;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Cuenect WebSocket Signaling Bridge Server
Usage: node server.js [options]

Options:
  -p, --port <number>    Set local server port (default: 9000)
  -t, --token <string>   Set ngrok auth token for public tunnel
  --no-ngrok, --offline  Run purely on local LAN without cloud tunnel
  -h, --help             Show this help message
      `);
      process.exit(0);
    }
  }

  return config;
}

function saveToken(token) {
  try {
    fs.writeFileSync(TOKEN_STORE_PATH, token.trim(), { encoding: "utf-8" });
    return true;
  } catch (err) {
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
  saveToken,
  readSavedToken,
  deleteToken
};
