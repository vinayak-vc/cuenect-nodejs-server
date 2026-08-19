const qrcode = require("qrcode-terminal");
const { exec } = require("child_process");

function stripAnsi(str) {
  return (str || "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

function copyToClipboard(text) {
  if (!text) return;
  try {
    if (process.platform === "win32") {
      const proc = exec("clip");
      proc.stdin.write(text);
      proc.stdin.end();
    }
  } catch {
    // Ignore if clip is unavailable
  }
}

class Dashboard {
  constructor(port = 9000, localIps = ["127.0.0.1"], publicUrl = null) {
    this.port = port;
    this.localIps = localIps;
    this.publicUrl = publicUrl;
    this.startTime = Date.now();
    this.activeUsers = new Set();
    this.events = [];
    this.maxEvents = 5;
    this.messageCount = 0;
    this.qrLines = [];
    this.alert = null;
    this.clipboardNotice = null;
    this.clipboardTimer = null;
    this.renderTimer = null;
    this.contentWidth = 76; // Inner width between borders

    this.generateQrCode();
  }

  generateQrCode() {
    const webBase = "https://cuenect-offline.netlify.app/";
    const targetUrl = this.publicUrl
      ? `${webBase}?server=${encodeURIComponent(this.publicUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:"))}`
      : `${webBase}?host=${this.localIps[0] || "127.0.0.1"}&port=${this.port}&usePort=true`;
    try {
      qrcode.generate(targetUrl, { small: true }, (qr) => {
        this.qrLines = qr.split("\n").filter((l) => l.trim().length > 0);
      });
    } catch {
      this.qrLines = ["  [QR Code Unavailable]  "];
    }
  }

  getPrimaryLanUrl() {
    return `http://${this.localIps[0] || "127.0.0.1"}:${this.port}`;
  }

  setPublicUrl(url) {
    this.publicUrl = url;
    this.generateQrCode();
    copyToClipboard(url);
    this.flashClipboardNotice("Public Cloud URL copied to clipboard (Ctrl+V)");
    this.log("TUNNEL", `Cloud tunnel: ${url}`);
    this.render();
  }

  flashClipboardNotice(msg) {
    this.clipboardNotice = msg;
    if (this.clipboardTimer) clearTimeout(this.clipboardTimer);
    this.clipboardTimer = setTimeout(() => {
      this.clipboardNotice = null;
      this.render();
    }, 4000);
  }

  copyCloudUrl() {
    if (this.publicUrl) {
      copyToClipboard(this.publicUrl);
      this.flashClipboardNotice(`Copied Cloud URL: ${this.publicUrl}`);
    } else {
      this.flashClipboardNotice("No Cloud URL active. Local LAN only.");
    }
    this.render();
  }

  copyLanUrl() {
    const lanUrl = this.getPrimaryLanUrl();
    copyToClipboard(lanUrl);
    this.flashClipboardNotice(`Copied LAN URL: ${lanUrl}`);
    this.render();
  }

  addUser(username) {
    this.activeUsers.add(username);
    this.pushEvent("JOIN", `Client connected: "${username}"`);
    this.render();
  }

  removeUser(username) {
    this.activeUsers.delete(username);
    this.pushEvent("LEAVE", `Client disconnected: "${username}"`);
    this.render();
  }

  setUsers(usersList) {
    this.activeUsers = new Set(usersList);
    this.render();
  }

  incrementMessage(actionType = "RELAY", summary = "") {
    this.messageCount++;
    if (summary) {
      this.pushEvent(actionType, summary);
    }
  }

  pushEvent(category, message) {
    const time = new Date().toLocaleTimeString();
    this.events.unshift({ time, category: category.toUpperCase(), message });
    if (this.events.length > this.maxEvents) {
      this.events.pop();
    }
  }

  log(category, message) {
    this.pushEvent(category, message);
  }

  setAlert(type, title, description) {
    this.alert = { type, title, description, time: new Date().toLocaleTimeString() };
    this.render();
  }

  clearAlert() {
    this.alert = null;
    this.render();
  }

  getUptimeString() {
    const totalSec = Math.floor((Date.now() - this.startTime) / 1000);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }

  start() {
    // Set console title
    if (process.stdout.isTTY) {
      process.stdout.write("\x1b]0;Cuenect Hologram Stage Bridge Server v2.1\x07");
      process.stdout.write("\x1b[?25l");
    }

    // Auto-copy local LAN URL if no public URL initially
    if (!this.publicUrl) {
      copyToClipboard(this.getPrimaryLanUrl());
      this.flashClipboardNotice("LAN URL copied to clipboard (Ctrl+V)");
    }

    // Non-blocking keyboard shortcuts [C] and [L]
    this.setupKeyboardShortcuts();

    this.render();
    this.renderTimer = setInterval(() => {
      this.render();
    }, 1000);
  }

  setupKeyboardShortcuts() {
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (key) => {
          if (key === "\u0003") {
            // Ctrl+C
            process.emit("SIGINT");
            return;
          }
          if (key === "c" || key === "C") {
            this.copyCloudUrl();
          } else if (key === "l" || key === "L") {
            this.copyLanUrl();
          }
        });
      }
    } catch {
      // Non-interactive fallback
    }
  }

  stop() {
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[?25h");
    }
  }

  formatRow(content) {
    const visibleLength = stripAnsi(content).length;
    const padding = Math.max(0, this.contentWidth - visibleLength);
    return `║ ${content}${" ".repeat(padding)} ║`;
  }

  render() {
    const out = [];
    out.push("\x1b[H\x1b[2J");

    const w = this.contentWidth;
    const border = "═".repeat(w + 2);
    const line = "─".repeat(w + 2);

    // 1. Header
    out.push(`╔${border}╗`);
    out.push(
      this.formatRow(
        `\x1b[1;36mCUENECT HOLOGRAM STAGE BRIDGE v2.1\x1b[0m                \x1b[1;32m● ONLINE (Port ${this.port})\x1b[0m`
      )
    );
    out.push(`╠${border}╣`);

    // 2. Metrics Bar
    const uptime = this.getUptimeString();
    const userCount = this.activeUsers.size;
    out.push(
      this.formatRow(
        `Uptime: \x1b[1m${uptime}\x1b[0m  │  Clients: \x1b[1;32m${userCount}\x1b[0m  │  Messages Relayed: \x1b[1m${this.messageCount}\x1b[0m`
      )
    );
    out.push(`╟${line}╢`);

    // 3. Network Endpoints
    out.push(this.formatRow(`\x1b[1;33m[NETWORK ENDPOINTS]\x1b[0m`));
    out.push(this.formatRow(`Local LAN   : \x1b[1;36m${this.getPrimaryLanUrl()}\x1b[0m`));
    if (this.publicUrl) {
      out.push(this.formatRow(`Public Cloud: \x1b[1;32m${this.publicUrl}\x1b[0m`));
    } else {
      out.push(this.formatRow(`Public Cloud: \x1b[90m(None - use --token <ngrok_token> for cloud link)\x1b[0m`));
    }
    out.push(this.formatRow(`Protocols   : \x1b[35mSocket.IO v4\x1b[0m & \x1b[35mWebSocket (Port ${this.port})\x1b[0m`));
    out.push(`╟${line}╢`);

    // 4. Clipboard Notice (if active)
    if (this.clipboardNotice) {
      out.push(this.formatRow(`\x1b[1;42;30m 📋 ${this.clipboardNotice} \x1b[0m`));
      out.push(`╟${line}╢`);
    }

    // 5. QR Code & Connected Sessions (Side by Side)
    out.push(
      this.formatRow(
        `\x1b[1;33m[SCAN QR TO CONNECT]\x1b[0m                  \x1b[1;33m[CONNECTED SESSIONS]\x1b[0m`
      )
    );

    const usersArr = Array.from(this.activeUsers);
    const maxRows = Math.max(this.qrLines.length, 6);

    for (let i = 0; i < maxRows; i++) {
      const rawQr = this.qrLines[i] || "";
      const qrLen = stripAnsi(rawQr).length;
      const qrPadded = rawQr + " ".repeat(Math.max(0, 36 - qrLen));

      let userCol = "";
      if (i === 0 && usersArr.length === 0) {
        userCol = "\x1b[90mWaiting for Stage & Web App...\x1b[0m";
      } else if (i < usersArr.length) {
        userCol = `\x1b[32m✔\x1b[0m ${usersArr[i]}`;
      }

      const combined = `${qrPadded} │ ${userCol}`;
      out.push(this.formatRow(combined));
    }

    out.push(`╟${line}╢`);

    // 6. Alert Box (If any)
    if (this.alert) {
      const alertColor = this.alert.type === "error" ? "\x1b[1;41;37m" : "\x1b[1;43;30m";
      out.push(this.formatRow(`${alertColor} ALERT: ${this.alert.title} \x1b[0m`));
      out.push(this.formatRow(`  ${this.alert.description}`));
      out.push(`╟${line}╢`);
    }

    // 7. Live Activity Feed
    out.push(this.formatRow(`\x1b[1;33m[LIVE ACTIVITY FEED]\x1b[0m`));
    if (this.events.length === 0) {
      out.push(this.formatRow(`  \x1b[90mNo events recorded yet. Ready for incoming commands...\x1b[0m`));
    } else {
      for (const ev of this.events) {
        let tagColor = "\x1b[36m";
        if (ev.category === "ERROR") tagColor = "\x1b[1;31m";
        if (ev.category === "JOIN" || ev.category === "STAGE") tagColor = "\x1b[1;32m";
        if (ev.category === "MODEL" || ev.category === "STEREO") tagColor = "\x1b[1;35m";
        if (ev.category === "WARN") tagColor = "\x1b[1;33m";

        const logLine = `  \x1b[90m${ev.time}\x1b[0m ${tagColor}[${ev.category}]\x1b[0m ${ev.message}`;
        out.push(this.formatRow(logLine));
      }
    }

    // 8. Footer Box
    out.push(`╚${border}╝`);
    out.push(` \x1b[1mShortcuts:\x1b[0m Press \x1b[1;32m[C]\x1b[0m Copy Cloud URL  │  Press \x1b[1;36m[L]\x1b[0m Copy LAN URL  │  \x1b[90m[Ctrl+C] Exit\x1b[0m`);
    if (this.publicUrl) {
      out.push(` \x1b[90mCloud URL: ${this.publicUrl}\x1b[0m`);
    } else {
      out.push(` \x1b[90mLAN URL  : ${this.getPrimaryLanUrl()}\x1b[0m`);
    }

    process.stdout.write(out.join("\n") + "\n");
  }
}

module.exports = {
  Dashboard
};
