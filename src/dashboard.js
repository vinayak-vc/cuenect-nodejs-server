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
  constructor(port = 9000, localIps = ["127.0.0.1"], publicUrl = null, preferredHost = null) {
    this.port = port;
    this.localIps = localIps;
    this.publicUrl = publicUrl;
    this.preferredHost = preferredHost;
    this.startTime = Date.now();
    this.activeUsers = new Set();
    this.events = [];
    this.maxEvents = 4;
    this.messageCount = 0;
    this.qrLines = [];
    this.qrWidth = 35;
    this.qrHeight = 18;
    this.rightWidth = 36;
    this.alert = null;
    this.notice = null;
    this.noticeTimer = null;
    this.started = false;
    this.uptimeTimer = null;
    this.isFullRenderPending = true;

    this.generateQrCode();
  }

  getPrimaryLanIp() {
    if (this.preferredHost) return this.preferredHost;
    const first = this.localIps[0];
    if (!first) return "127.0.0.1";
    if (typeof first === "object") return first.address || first.ip || "127.0.0.1";
    return first;
  }

  getWebConnectUrl() {
    const webBase = "https://cuenect-offline.netlify.app/";
    if (this.publicUrl) {
      const socketUrl = this.publicUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
      return `${webBase}?server=${encodeURIComponent(socketUrl)}`;
    }
    const localIp = this.getPrimaryLanIp();
    return `${webBase}?host=${localIp}&port=${this.port}&usePort=true`;
  }

  generateQrCode() {
    const targetUrl = this.getWebConnectUrl();
    try {
      qrcode.generate(targetUrl, { small: true }, (qr) => {
        this.qrLines = qr.split("\n").filter((l) => l.trim().length > 0);
      });
    } catch {
      this.qrLines = [];
    }

    if (this.qrLines.length > 0) {
      this.qrWidth = stripAnsi(this.qrLines[0]).length;
      this.qrHeight = this.qrLines.length;
    } else {
      this.qrWidth = 35;
      this.qrHeight = 18;
      this.qrLines = Array(18).fill(" ".repeat(35));
    }

    // Keep total width <= 78 so it never wraps on 80-col terminals
    this.rightWidth = Math.max(34, 78 - this.qrWidth - 3);
  }

  getPrimaryLanUrl() {
    return `http://${this.getPrimaryLanIp()}:${this.port}`;
  }

  setPublicUrl(url) {
    this.publicUrl = url;
    this.generateQrCode();
    copyToClipboard(url);
    this.flashNotice(`Cloud URL active & copied (Ctrl+V)`);
    this.pushEvent("TUNNEL", `Cloud tunnel: ${url}`);
    if (process.stdout.isTTY && this.started) {
      this.renderFull();
    }
  }

  flashNotice(msg) {
    this.notice = msg;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    if (process.stdout.isTTY && this.started) {
      this.updateFooter();
    }
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
      if (process.stdout.isTTY && this.started) {
        this.updateFooter();
      }
    }, 4000);
  }

  copyCloudUrl() {
    if (this.publicUrl) {
      copyToClipboard(this.publicUrl);
      this.flashNotice(`Copied Cloud URL: ${this.publicUrl}`);
    } else {
      this.flashNotice("No Cloud URL active. Local LAN only.");
    }
  }

  copyLanUrl() {
    const lanUrl = this.getPrimaryLanUrl();
    copyToClipboard(lanUrl);
    this.flashNotice(`Copied LAN URL: ${lanUrl}`);
  }

  addUser(username) {
    this.activeUsers.add(username);
    this.pushEvent("JOIN", `Client: "${username}"`);
    if (process.stdout.isTTY && !this.isFullRenderPending) {
      this.updateMetrics();
      this.updateSessions();
    }
  }

  removeUser(username) {
    this.activeUsers.delete(username);
    this.pushEvent("LEAVE", `Client left: "${username}"`);
    if (process.stdout.isTTY && !this.isFullRenderPending) {
      this.updateMetrics();
      this.updateSessions();
    }
  }

  setUsers(usersList) {
    this.activeUsers = new Set(usersList);
    if (process.stdout.isTTY && !this.isFullRenderPending) {
      this.updateMetrics();
      this.updateSessions();
    }
  }

  incrementMessage(actionType = "RELAY", summary = "") {
    this.messageCount++;
    if (summary) {
      this.pushEvent(actionType, summary);
    } else if (process.stdout.isTTY && !this.isFullRenderPending) {
      this.updateMetrics();
    }
  }

  pushEvent(category, message) {
    const time = new Date().toLocaleTimeString();
    this.events.unshift({ time, category: category.toUpperCase(), message });
    if (this.events.length > this.maxEvents) {
      this.events.pop();
    }

    if (process.stdout.isTTY && this.started) {
      this.updateFeed();
    } else if (!process.stdout.isTTY) {
      console.log(`${time} [${category.toUpperCase()}] ${message}`);
    }
  }

  log(category, message) {
    this.pushEvent(category, message);
  }

  setAlert(type, title, description) {
    this.alert = { type, title, description, time: new Date().toLocaleTimeString() };
    if (process.stdout.isTTY && this.started) {
      this.renderFull();
    } else if (!process.stdout.isTTY) {
      console.error(`[ALERT ${type.toUpperCase()}] ${title}: ${description}`);
    }
  }

  clearAlert() {
    this.alert = null;
    if (process.stdout.isTTY && this.started) {
      this.renderFull();
    }
  }

  getUptimeString() {
    const totalSec = Math.floor((Date.now() - this.startTime) / 1000);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }

  pad(str, targetLen) {
    const len = stripAnsi(str).length;
    if (len >= targetLen) return str;
    return str + " ".repeat(targetLen - len);
  }

  truncate(str, maxLen) {
    const stripped = stripAnsi(str);
    if (stripped.length <= maxLen) return str;
    return stripped.slice(0, maxLen - 1) + "…";
  }

  getRightCol() {
    // 1-indexed column where right panel starts: qrWidth + 3 (' │ ') + 1
    return this.qrWidth + 4;
  }

  /* ─────────────────────────────────────────────────────────────
   * Micro-Updates: Updates only individual fields in-place
   * ZERO screen clearing, ZERO duplicate blocks in scrollback
   * ───────────────────────────────────────────────────────────── */

  updateUptime() {
    if (!process.stdout.isTTY || this.isFullRenderPending) return;
    const uptime = this.getUptimeString();
    const rightCol = this.getRightCol();
    // Row 4: Port: XXXX      Uptime: 00:00:00
    // "Port: 9000".length = 10 + 6 spaces = 16 chars from rightCol
    const uptimeCol = rightCol + 18;
    process.stdout.write(`\x1b[4;${uptimeCol}H\x1b[1;33m${uptime}\x1b[0m`);
  }

  updateMetrics() {
    if (!process.stdout.isTTY || this.isFullRenderPending) return;
    const userCount = this.activeUsers.size;
    const rightCol = this.getRightCol();
    // Row 5: Clients: X      Relayed: Y
    const clientsCol = rightCol + 9;
    const relayedCol = rightCol + 23;
    process.stdout.write(`\x1b[5;${clientsCol}H\x1b[1;32m${userCount}\x1b[0m   `);
    process.stdout.write(`\x1b[5;${relayedCol}H\x1b[1m${this.messageCount}\x1b[0m     `);
  }

  updateSessions() {
    if (!process.stdout.isTTY || this.isFullRenderPending) return;
    const rightCol = this.getRightCol();
    const usersArr = Array.from(this.activeUsers);
    let sessionsText = "";
    if (usersArr.length === 0) {
      sessionsText = "\x1b[90mWaiting for connections...\x1b[0m";
    } else {
      sessionsText = usersArr.slice(0, 2).map((u) => `\x1b[32m✔\x1b[0m ${this.truncate(u, 12)}`).join(" ");
    }
    // Row 12
    process.stdout.write(`\x1b[12;${rightCol}H${this.pad(sessionsText, this.rightWidth)}\x1b[K`);
  }

  updateFeed() {
    if (!process.stdout.isTTY || this.isFullRenderPending) return;
    const rightCol = this.getRightCol();
    // Rows 15 to 18
    for (let i = 0; i < 4; i++) {
      const row = 15 + i;
      const ev = this.events[i];
      let lineText = "\x1b[90m---\x1b[0m";
      if (ev) {
        let tagColor = "\x1b[36m";
        if (ev.category === "ERROR") tagColor = "\x1b[1;31m";
        else if (ev.category === "JOIN" || ev.category === "STAGE") tagColor = "\x1b[1;32m";
        else if (ev.category === "MODEL" || ev.category === "STEREO") tagColor = "\x1b[1;35m";
        else if (ev.category === "WARN" || ev.category === "JOYSTICK") tagColor = "\x1b[1;33m";

        const text = `${ev.time} ${tagColor}[${ev.category}]\x1b[0m ${ev.message}`;
        lineText = this.truncate(text, this.rightWidth);
      }
      process.stdout.write(`\x1b[${row};${rightCol}H${this.pad(lineText, this.rightWidth)}\x1b[K`);
    }
  }

  updateFooter() {
    if (!process.stdout.isTTY || this.isFullRenderPending) return;
    const totalW = this.qrWidth + 3 + this.rightWidth;
    let footerText = `Shortcuts: \x1b[1;32m[C]\x1b[0m Copy Cloud  │  \x1b[1;36m[L]\x1b[0m Copy LAN  │  \x1b[90m[Ctrl+C] Exit\x1b[0m`;
    if (this.notice) {
      footerText = `\x1b[1;42;30m ✔ ${this.notice} \x1b[0m`;
    }
    const footerRow = this.qrHeight + 2;
    process.stdout.write(`\x1b[${footerRow};1H${this.pad(footerText, totalW)}\x1b[K`);
  }

  /* ─────────────────────────────────────────────────────────────
   * Full Render: Compact 20-22 lines total, fits in any terminal
   * Always drawn from \x1b[H without \x1b[2J so no duplicate blocks
   * ───────────────────────────────────────────────────────────── */

  render() {
    this.renderFull();
  }

  renderFull() {
    if (!process.stdout.isTTY) return;

    const qrW = this.qrWidth;
    const rW = this.rightWidth;
    const sep = " │ ";

    const uptime = this.getUptimeString();
    const userCount = this.activeUsers.size;
    const usersArr = Array.from(this.activeUsers);
    const lanUrl = `http://${this.getPrimaryLanIp()}:${this.port}`;
    const cloudUrl = this.publicUrl || "(None - use --token)";

    let sessionsText = "";
    if (usersArr.length === 0) {
      sessionsText = "\x1b[90mWaiting for connections...\x1b[0m";
    } else {
      sessionsText = usersArr.slice(0, 2).map((u) => `\x1b[32m✔\x1b[0m ${this.truncate(u, 12)}`).join(" ");
    }

    const rightLines = [
      this.pad(`\x1b[1;36mCUENECT HOLOGRAM BRIDGE v2.1\x1b[0m`, rW),
      this.pad(`\x1b[90mEngine:\x1b[0m Unity + WebGL  \x1b[1;32m● ONLINE\x1b[0m`, rW),
      "─".repeat(rW),
      this.pad(`Port: \x1b[1m${this.port}\x1b[0m      Uptime: \x1b[1;33m${uptime}\x1b[0m`, rW),
      this.pad(`Clients: \x1b[1;32m${userCount}\x1b[0m     Relayed: \x1b[1m${this.messageCount}\x1b[0m`, rW),
      "─".repeat(rW),
      this.pad(`\x1b[1;33m[NETWORK ENDPOINTS]\x1b[0m`, rW),
      this.pad(`LAN  : \x1b[36m${this.truncate(lanUrl, rW - 7)}\x1b[0m`, rW),
      this.pad(`Cloud: \x1b[32m${this.truncate(cloudUrl, rW - 7)}\x1b[0m`, rW),
      "─".repeat(rW),
      this.pad(`\x1b[1;33m[CONNECTED SESSIONS]\x1b[0m`, rW),
      this.pad(sessionsText, rW),
      "─".repeat(rW),
      this.pad(`\x1b[1;33m[ACTIVITY FEED]\x1b[0m`, rW)
    ];

    // Activity feed: 4 lines (rows 15 to 18)
    for (let i = 0; i < 4; i++) {
      const ev = this.events[i];
      if (ev) {
        let tagColor = "\x1b[36m";
        if (ev.category === "ERROR") tagColor = "\x1b[1;31m";
        else if (ev.category === "JOIN" || ev.category === "STAGE") tagColor = "\x1b[1;32m";
        else if (ev.category === "MODEL" || ev.category === "STEREO") tagColor = "\x1b[1;35m";
        else if (ev.category === "WARN" || ev.category === "JOYSTICK") tagColor = "\x1b[1;33m";

        const text = `${ev.time} ${tagColor}[${ev.category}]\x1b[0m ${ev.message}`;
        rightLines.push(this.pad(this.truncate(text, rW), rW));
      } else {
        rightLines.push(this.pad("\x1b[90m---\x1b[0m", rW));
      }
    }

    // Pad rightLines to match qrHeight
    while (rightLines.length < this.qrHeight) {
      if (this.alert && rightLines.length === this.qrHeight - 1) {
        const alertTag = this.alert.type === "error" ? "\x1b[1;41;37m" : "\x1b[1;43;30m";
        rightLines.push(this.pad(`${alertTag} ${this.alert.title} \x1b[0m`, rW));
      } else {
        rightLines.push(" ".repeat(rW));
      }
    }

    const maxRows = Math.max(this.qrHeight, rightLines.length);
    const out = [];
    out.push("\x1b[H"); // Cursor Home - Overwrites in place without scrolling

    for (let i = 0; i < maxRows; i++) {
      const q = this.qrLines[i] || " ".repeat(qrW);
      const r = rightLines[i] || " ".repeat(rW);
      out.push(q + sep + r + "\x1b[K");
    }

    const totalW = qrW + sep.length + rW;
    out.push("─".repeat(totalW) + "\x1b[K");

    let footer = `Shortcuts: \x1b[1;32m[C]\x1b[0m Copy Cloud  │  \x1b[1;36m[L]\x1b[0m Copy LAN  │  \x1b[90m[Ctrl+C] Exit\x1b[0m`;
    if (this.notice) {
      footer = `\x1b[1;42;30m ✔ ${this.notice} \x1b[0m`;
    }
    out.push(this.pad(footer, totalW) + "\x1b[K");

    process.stdout.write(out.join("\n") + "\n");
    this.isFullRenderPending = false;
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

  start() {
    if (this.started) return;
    this.started = true;

    const lanUrl = this.getPrimaryLanUrl();
    copyToClipboard(lanUrl);

    if (process.stdout.isTTY) {
      process.stdout.write("\x1b]0;Cuenect Hologram Stage Bridge Server v2.1\x07");
      // Clear viewport and scrollback ONCE at initial launch
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

      // Setup non-blocking [C] and [L] shortcuts
      this.setupKeyboardShortcuts();

      // Initial full render
      this.renderFull();

      // 1-second interval ONLY updates the 8 characters of uptime in-place!
      // It NEVER reprints the full block!
      this.uptimeTimer = setInterval(() => {
        this.updateUptime();
      }, 1000);
    } else {
      console.log(`[SYS] Cuenect Bridge Server started on port ${this.port}`);
      console.log(`[SYS] Local LAN: ${lanUrl}`);
    }
  }

  stop() {
    if (this.uptimeTimer) {
      clearInterval(this.uptimeTimer);
      this.uptimeTimer = null;
    }
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.started = false;
  }
}

module.exports = {
  Dashboard
};
