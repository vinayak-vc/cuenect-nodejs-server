function printBanner(localIps, port, publicUrl = null) {
  console.log("\n============================================================");
  console.log("       CUENECT HOLOGRAM STAGE SIGNALING BRIDGE SERVER       ");
  console.log("============================================================");
  console.log(` Status      : Online`);
  console.log(` Local Port  : ${port}`);
  console.log("\n Local Network Endpoints (Wi-Fi / LAN):");
  localIps.forEach((ip) => {
    console.log(`   ➜ ws://${ip}:${port}/`);
  });

  if (publicUrl) {
    console.log("\n Public Cloud Endpoint (Ngrok Tunnel):");
    console.log(`   ➜ ${publicUrl}`);

    try {
      const qrcode = require("qrcode-terminal");
      console.log("\n Scan with Mobile Camera to Connect:");
      qrcode.generate(publicUrl, { small: true });
    } catch {
      // Ignore if qrcode-terminal is omitted
    }
  } else {
    // Print QR code for first local IP
    try {
      const qrcode = require("qrcode-terminal");
      const primaryUrl = `ws://${localIps[0]}:${port}/`;
      console.log(`\n Scan with Mobile Camera (Local Wi-Fi):`);
      qrcode.generate(primaryUrl, { small: true });
    } catch {
      // Ignore
    }
  }

  console.log("============================================================\n");
}

module.exports = {
  printBanner
};
