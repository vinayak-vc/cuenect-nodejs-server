const os = require("os");

/**
 * Discovers valid IPv4 network addresses on the local machine.
 * Prioritizes standard Wi-Fi / Ethernet LAN subnets (192.168.x.x) over
 * corporate/VPN/virtual ranges (10.x.x.x, 172.x.x.x).
 *
 * @param {string} [preferredHost] - Optional explicitly configured host/IP to prioritize
 * @returns {string[]} Ordered list of IPv4 addresses
 */
function getMachineIPAddresses(preferredHost = null) {
  const interfaces = os.networkInterfaces();

  // Pattern matching virtual network adapters, Hyper-V, WSL, Docker, and VPNs
  const virtualOrVpnRegex =
    /vethernet|virtual|docker|vmnet|vbox|wsl|hyper-v|tap|tun|tailscale|zerotier|hamachi|wireguard|anyconnect|openvpn|fortinet|pnp|bluetooth/i;

  const scoredAddresses = [];

  for (const name of Object.keys(interfaces)) {
    const isVirtualOrVpn = virtualOrVpnRegex.test(name);
    const isWireless = /wi-?fi|wireless|wlan/i.test(name);
    const isEthernet = /ethernet/i.test(name);

    for (const iface of interfaces[name]) {
      // Must be non-internal IPv4
      if (iface.family !== "IPv4" || iface.internal || !iface.address) {
        continue;
      }

      const addr = iface.address.trim();

      // Ignore loopback (127.x.x.x) and APIPA/link-local (169.254.x.x)
      if (addr.startsWith("127.") || addr.startsWith("169.254.")) {
        continue;
      }

      let score = 0;

      // 1. Explicitly preferred host gets maximum priority
      if (preferredHost && addr === preferredHost.trim()) {
        score += 1000;
      }

      // 2. Physical vs Virtual/VPN
      if (!isVirtualOrVpn) {
        // Physical adapter
        if (addr.startsWith("192.168.")) {
          // Standard consumer & office Wi-Fi / LAN - top priority for phone/tablet connections
          score += 100;
        } else if (addr.startsWith("10.")) {
          score += 60;
        } else if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(addr)) {
          score += 50;
        } else {
          score += 40;
        }

        // Interface type weighting (Wi-Fi is typically what mobile devices connect to)
        if (isWireless) score += 15;
        else if (isEthernet) score += 10;
      } else {
        // Virtual or VPN adapter
        if (addr.startsWith("192.168.")) score += 20;
        else if (addr.startsWith("10.")) score += 10;
        else score += 5;
      }

      scoredAddresses.push({ address: addr, score, interfaceName: name });
    }
  }

  // Sort by score descending
  scoredAddresses.sort((a, b) => b.score - a.score);

  // Deduplicate addresses while preserving order
  const uniqueAddresses = [];
  const seen = new Set();

  // If a valid preferred host was supplied and not found in interfaces, ensure it is first
  if (
    preferredHost &&
    typeof preferredHost === "string" &&
    !seen.has(preferredHost.trim()) &&
    !preferredHost.startsWith("127.") &&
    !preferredHost.startsWith("169.254.")
  ) {
    const cleanPref = preferredHost.trim();
    uniqueAddresses.push(cleanPref);
    seen.add(cleanPref);
  }

  for (const item of scoredAddresses) {
    if (!seen.has(item.address)) {
      seen.add(item.address);
      uniqueAddresses.push(item.address);
    }
  }

  if (uniqueAddresses.length === 0) {
    uniqueAddresses.push("127.0.0.1");
  }

  return uniqueAddresses;
}

module.exports = {
  getMachineIPAddresses
};
