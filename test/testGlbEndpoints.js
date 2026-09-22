/**
 * Automated test for GLB Inspector and HTTP streaming endpoints.
 */

const assert = require("assert");
const http = require("http");
const { inspectGlb, resolveModelFilePath, MAX_FILE_SIZE_BYTES, MAX_TRIANGLE_COUNT } = require("../src/glbInspector");
const { SignalingServer } = require("../src/signalingServer");

async function runTests() {
  console.log("▶ [Test 1] Inspecting valid GLB: 1_Leather_Jacket.glb...");
  const info = inspectGlb("1_Leather_Jacket.glb");
  assert.strictEqual(info.exists, true, "File should exist");
  assert.strictEqual(info.isLoadable, true, "File should be loadable (under 25MB and 250k tris)");
  assert.strictEqual(typeof info.triangleCount, "number");
  assert(info.triangleCount > 1000, "Should have triangles");
  assert(info.fileSizeBytes > 1000000, "Should have file size > 1MB");
  assert(info.fileSizeBytes <= MAX_FILE_SIZE_BYTES, "Should be under 25MB");
  assert(info.triangleCount <= MAX_TRIANGLE_COUNT, "Should be under 250k triangles");
  console.log(`  ✔ Leather Jacket: ${info.fileSizeMB} MB, ${info.triangleCount} triangles, loadable: ${info.isLoadable}`);

  console.log("▶ [Test 2] Inspecting non-existent GLB...");
  const notFound = inspectGlb("does_not_exist_at_all.glb");
  assert.strictEqual(notFound.exists, false, "Should return exists: false");
  assert.strictEqual(notFound.isLoadable, false, "Should not be loadable");
  console.log("  ✔ Non-existent file handled correctly");

  console.log("▶ [Test 3] Testing HTTP server routes on port 9199...");
  const testPort = 9199;
  const server = new SignalingServer(testPort);
  await server.start();

  try {
    // 3a. Test /api/model-info
    const infoRes = await fetchJson(`http://127.0.0.1:${testPort}/api/model-info?file=1_Leather_Jacket.glb`);
    assert.strictEqual(infoRes.status, 200, "model-info should return 200");
    assert.strictEqual(infoRes.data.isLoadable, true, "model-info data should be loadable");
    assert.strictEqual(infoRes.data.triangleCount, info.triangleCount);
    console.log("  ✔ /api/model-info returned valid metadata");

    // 3b. Test /api/model (HEAD request)
    const headRes = await fetchHead(`http://127.0.0.1:${testPort}/api/model?file=1_Leather_Jacket.glb`);
    assert.strictEqual(headRes.status, 200, "HEAD request should return 200");
    assert.strictEqual(headRes.headers["content-type"], "model/gltf-binary");
    assert.strictEqual(headRes.headers["accept-ranges"], "bytes");
    console.log("  ✔ /api/model HEAD returned 200 with model/gltf-binary");

    // 3c. Test /api/model with Range request
    const rangeRes = await fetchRange(`http://127.0.0.1:${testPort}/api/model?file=1_Leather_Jacket.glb`, 0, 11);
    assert.strictEqual(rangeRes.status, 206, "Range request should return 206 Partial Content");
    assert.strictEqual(rangeRes.buffer.length, 12, "Should return 12 bytes");
    assert.strictEqual(rangeRes.buffer.readUInt32LE(0), 0x46546c67, "First 4 bytes must be 'glTF' magic");
    console.log("  ✔ /api/model Range request returned 206 with correct 12-byte GLB header");

    // 3d. Test 404 on missing file
    const missingRes = await fetchJson(`http://127.0.0.1:${testPort}/api/model?file=not_there.glb`);
    assert.strictEqual(missingRes.status, 404, "Missing file should return 404");
    console.log("  ✔ /api/model 404 on missing file verified");
  } finally {
    await server.stop();
  }

  console.log("\n All backend tests passed successfully!\n");
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
      res.on("error", reject);
    });
  });
}

function fetchHead(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "HEAD"
      },
      (res) => {
        resolve({ status: res.statusCode, headers: res.headers });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function fetchRange(url, start, end) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: { Range: `bytes=${start}-${end}` }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
