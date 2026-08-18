class TunnelManager {
  constructor() {
    this.tunnel = null;
    this.publicUrl = null;
  }

  async start(port, authtoken) {
    if (!authtoken) {
      return null;
    }

    let ngrok;
    try {
      ngrok = require("@ngrok/ngrok");
    } catch {
      console.warn("[Tunnel] @ngrok/ngrok dependency not installed. Running in LAN-only mode.");
      return null;
    }

    try {
      console.log("[Tunnel] Initializing ngrok secure cloud tunnel...");
      this.tunnel = await ngrok.forward({
        addr: port,
        authtoken: authtoken.trim()
      });

      let rawUrl = this.tunnel.url();
      if (rawUrl) {
        this.publicUrl = rawUrl.replace("https://", "wss://").replace("http://", "ws://");
        return this.publicUrl;
      }
    } catch (err) {
      console.warn("[Tunnel] Failed to establish ngrok tunnel:", err.message);
      console.log("[Tunnel] Continuing in local LAN mode.");
    }

    return null;
  }

  async stop() {
    if (this.tunnel) {
      try {
        const ngrok = require("@ngrok/ngrok");
        await ngrok.disconnect(this.tunnel.url());
        await ngrok.kill();
      } catch {
        // Ignore shutdown errors
      }
      this.tunnel = null;
      this.publicUrl = null;
    }
  }
}

module.exports = {
  TunnelManager
};
