const os = require("os");

/**
 * Discovers valid IPv4 network addresses on the local machine.
 * Prioritizes physical Wi-Fi/Ethernet adapters over virtual adapters.
 */
function getMachineIPAddresses() {
  const interfaces = os.networkInterfaces();
  const physicalAddresses = [];
  const virtualAddresses = [];

  for (const name of Object.keys(interfaces)) {
    const isVirtual = /vethernet|virtual|docker|vmnet|vbox|wsl/i.test(name);

    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal && iface.address) {
        if (isVirtual) {
          virtualAddresses.push(iface.address);
        } else {
          physicalAddresses.push(iface.address);
        }
      }
    }
  }

  // Return physical addresses first, then virtual addresses as fallback
  const result = [...physicalAddresses, ...virtualAddresses];
  if (result.length === 0) {
    result.push("127.0.0.1");
  }
  return result;
}

module.exports = {
  getMachineIPAddresses
};
