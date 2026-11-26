const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { SignalingServer } = require("../src/signalingServer");

async function runTest() {
  console.log("▶ [Test Setup] Starting SignalingServer on port 9233...");
  const server = new SignalingServer(9233, "127.0.0.1");
  await server.start();

  try {
    console.log("▶ [Test 1] Testing /api/assets/upload with 2D configured graphic...");

    // 1x1 transparent PNG base64
    const samplePngBase64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    const payload = JSON.stringify({
      assetName: "Baby Girl Announcement Test",
      fileName: "baby_girl_test.png",
      imageData: samplePngBase64,
      category: 1, // DataType.Image
      playlistName: "Configurator",
      loadImmediately: true,
      projectData: {
        title: "Baby Girl Announcement Test",
        width: 1920,
        height: 1080
      }
    });

    const resData = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: 9233,
          path: "/api/assets/upload",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
          }
        },
        (res) => {
          let chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf-8");
            resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
          });
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    assert.strictEqual(resData.statusCode, 200, `Expected 200 OK, got ${resData.statusCode}`);
    assert.strictEqual(resData.body.ok, true, "Expected ok: true");
    assert.ok(resData.body.asset, "Expected asset object in response");
    assert.strictEqual(resData.body.asset.Category, 1, "Expected Category: 1 (Image)");
    assert.strictEqual(resData.body.asset.AssetName, "Baby Girl Announcement Test");
    assert.ok(fs.existsSync(resData.body.asset.ModelPath), "Expected image file to exist on disk");

    console.log("  ✔ Upload verified: File saved to " + resData.body.asset.ModelPath);

    console.log("▶ [Test 2] Testing /api/asset-file retrieval...");
    const fileRes = await new Promise((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:9233/api/asset-file?path=${encodeURIComponent(resData.body.asset.ModelPath)}`,
        (res) => {
          let chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            resolve({ statusCode: res.statusCode, length: Buffer.concat(chunks).length });
          });
        }
      );
      req.on("error", reject);
    });

    assert.strictEqual(fileRes.statusCode, 200, `Expected 200 for file download, got ${fileRes.statusCode}`);
    assert.ok(fileRes.length > 0, "Downloaded file length should be > 0");
    console.log("  ✔ Download verified: Successfully fetched uploaded image over HTTP stream");

    console.log("\n=============================================");
    console.log("🎉 ALL ASSET UPLOAD TESTS PASSED!");
    console.log("=============================================\n");
  } finally {
    await server.stop();
  }
}

runTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
