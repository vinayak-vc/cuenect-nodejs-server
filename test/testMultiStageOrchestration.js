/**
 * Automated Test for Multi-Stage Orchestration & Targeted Routing
 * Tests:
 * 1. Multi-stage registration (stage-register)
 * 2. Stage roster updates & /api/stages endpoint
 * 3. Targeted command dispatch (unicast, multicast, broadcast)
 * 4. Isolation verification (unselected stages do NOT receive packets)
 * 5. State updates (stage-state-update)
 * 6. Disconnect handling
 */

const assert = require("assert");
const http = require("http");
let ioClient;
try {
  ioClient = require("socket.io-client").io;
} catch (e) {
  ioClient = require("c:/ReactApp/cuenect-webfront-offline/node_modules/socket.io-client").io;
}
const { SignalingServer } = require("../src/signalingServer");

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    }).on("error", reject);
  });
}

function createClient(port, name = "Client") {
  return ioClient(`http://127.0.0.1:${port}`, {
    transports: ["websocket"],
    reconnection: false
  });
}

async function run() {
  const TEST_PORT = 9222;
  console.log(`▶ [Test Setup] Starting SignalingServer on port ${TEST_PORT}...`);
  const server = new SignalingServer(TEST_PORT);
  await server.start();
  console.log("  ✔ Server started successfully.");

  let stage1, stage2, stage3, controller;

  try {
    // 1. Connect Controller
    console.log("▶ [Test 1] Connecting Web Controller...");
    controller = createClient(TEST_PORT, "WebController");
    await new Promise((resolve) => controller.on("connect", resolve));

    let initialRosterReceived = false;
    let currentRoster = [];

    controller.on("stage-roster-update", (data) => {
      currentRoster = data.stages || [];
      initialRosterReceived = true;
    });

    controller.emit("login", { name: "Web_Controller_Admin", role: "controller" });
    await new Promise((r) => setTimeout(r, 200));
    console.log("  ✔ Web Controller connected and logged in.");

    // 2. Connect 3 Unity Stages
    console.log("▶ [Test 2] Connecting and registering 3 Unity Stages...");
    stage1 = createClient(TEST_PORT, "Stage1");
    stage2 = createClient(TEST_PORT, "Stage2");
    stage3 = createClient(TEST_PORT, "Stage3");

    await Promise.all([
      new Promise((resolve) => stage1.on("connect", resolve)),
      new Promise((resolve) => stage2.on("connect", resolve)),
      new Promise((resolve) => stage3.on("connect", resolve))
    ]);

    // Register stages with unique IDs and groups
    stage1.emit("stage-register", {
      stageId: "stage_01",
      displayName: "Stage 1 (Left Screen)",
      group: "Front Row"
    });

    stage2.emit("stage-register", {
      stageId: "stage_02",
      displayName: "Stage 2 (Center Screen)",
      group: "Front Row"
    });

    stage3.emit("stage-register", {
      stageId: "stage_03",
      displayName: "Stage 3 (Right Screen)",
      group: "Back Row"
    });

    // Wait for roster updates to propagate
    await new Promise((r) => setTimeout(r, 300));

    assert.strictEqual(currentRoster.length, 3, "Controller should see exactly 3 stages");
    const s1 = currentRoster.find((s) => s.stageId === "stage_01");
    const s2 = currentRoster.find((s) => s.stageId === "stage_02");
    const s3 = currentRoster.find((s) => s.stageId === "stage_03");

    assert(s1 && s1.online, "Stage 1 should be registered and online");
    assert(s2 && s2.online, "Stage 2 should be registered and online");
    assert(s3 && s3.online, "Stage 3 should be registered and online");
    console.log("  ✔ All 3 stages registered and visible to controller.");

    // 3. Test /api/stages HTTP endpoint
    console.log("▶ [Test 3] Verifying /api/stages HTTP REST endpoint...");
    const httpRes = await fetchJson(`http://127.0.0.1:${TEST_PORT}/api/stages`);
    assert.strictEqual(httpRes.status, 200);
    assert.strictEqual(httpRes.data.stages.length, 3);
    console.log("  ✔ /api/stages returned valid JSON roster with 3 stages.");

    // 4. Test Targeted Multicast (Targeting Stage 1 and Stage 2 only)
    console.log("▶ [Test 4] Testing targeted multicast to [stage_01, stage_02]...");
    let stage1Events = [];
    let stage2Events = [];
    let stage3Events = [];

    stage1.on("hologram-asset-action", (data) => stage1Events.push(data));
    stage2.on("hologram-asset-action", (data) => stage2Events.push(data));
    stage3.on("hologram-asset-action", (data) => stage3Events.push(data));

    controller.emit("dispatch-command", {
      targets: ["stage_01", "stage_02"],
      targetEvent: "hologram-asset-action",
      data: { AssetID: "apollo_11", title: "Apollo 11" }
    });

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(stage1Events.length, 1, "Stage 1 MUST receive the multicast event");
    assert.strictEqual(stage2Events.length, 1, "Stage 2 MUST receive the multicast event");
    assert.strictEqual(stage3Events.length, 0, "Stage 3 MUST NOT receive the multicast event (Isolation verified)");
    assert.strictEqual(stage1Events[0].AssetID, "apollo_11");
    console.log("  ✔ Multicast verified: Stage 1 and 2 received model, Stage 3 untouched.");

    // 5. Test Targeted Unicast (Solo action on Stage 3)
    console.log("▶ [Test 5] Testing solo unicast to [stage_03]...");
    controller.emit("dispatch-command", {
      targets: ["stage_03"],
      targetEvent: "hologram-asset-action",
      data: { AssetID: "t_rex", title: "T-Rex Skeleton" }
    });

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(stage1Events.length, 1, "Stage 1 event count unchanged");
    assert.strictEqual(stage2Events.length, 1, "Stage 2 event count unchanged");
    assert.strictEqual(stage3Events.length, 1, "Stage 3 received its solo model action");
    assert.strictEqual(stage3Events[0].AssetID, "t_rex");
    console.log("  ✔ Solo unicast verified: Only Stage 3 received T-Rex model.");

    // 6. Test Broadcast to All ("*")
    console.log("▶ [Test 6] Testing broadcast to all ('*')...");
    let stage1Resets = 0, stage2Resets = 0, stage3Resets = 0;
    stage1.on("hologram-model-action", () => stage1Resets++);
    stage2.on("hologram-model-action", () => stage2Resets++);
    stage3.on("hologram-model-action", () => stage3Resets++);

    controller.emit("dispatch-command", {
      targets: "*",
      targetEvent: "hologram-model-action",
      data: { action: "reset_transform" }
    });

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(stage1Resets, 1, "Stage 1 received broadcast");
    assert.strictEqual(stage2Resets, 1, "Stage 2 received broadcast");
    assert.strictEqual(stage3Resets, 1, "Stage 3 received broadcast");
    console.log("  ✔ Broadcast verified: All 3 stages acted simultaneously.");

    // 7. Test Stage State Reporting (stage-state-update)
    console.log("▶ [Test 7] Testing stage state reporting (currentModel sync)...");
    stage1.emit("stage-state-update", {
      stageId: "stage_01",
      currentModel: "apollo_11",
      displayMode: "HOLO"
    });

    await new Promise((r) => setTimeout(r, 200));

    const updatedS1 = currentRoster.find((s) => s.stageId === "stage_01");
    assert.strictEqual(updatedS1.currentModel, "apollo_11", "Controller roster should reflect stage 1 loaded model");
    assert.strictEqual(updatedS1.displayMode, "HOLO", "Controller roster should reflect stage 1 display mode");
    console.log("  ✔ State update verified: Controller sees Stage 1 has 'apollo_11' in 'HOLO' mode.");

    // 8. Test Disconnection Handling
    console.log("▶ [Test 8] Testing stage disconnection...");
    stage2.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    const disconnectedS2 = currentRoster.find((s) => s.stageId === "stage_02");
    assert(disconnectedS2, "Stage 2 should still be listed in roster");
    assert.strictEqual(disconnectedS2.online, false, "Stage 2 status should update to online: false");
    console.log("  ✔ Disconnect handling verified: Stage 2 marked offline in controller roster.");

    // 9. Test Hardware Persistent Identity (systemId auto-generation and reconnection)
    console.log("▶ [Test 9] Testing persistent hardware identity...");
    const hwStage = createClient(TEST_PORT, "HW-Stage-1");
    const hwAck1 = await new Promise((resolve) => {
      hwStage.on("connect", () => {
        hwStage.emit("stage-register", { systemId: "HW-Kiosk-101" });
      });
      hwStage.on("stage-registered", resolve);
    });
    assert(hwAck1.stageId, "Should allocate a stageId");
    assert(hwAck1.displayName, "Should allocate a displayName");
    hwStage.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    // Reconnect with same systemId
    const hwStageRecon = createClient(TEST_PORT, "HW-Stage-2");
    const hwAck2 = await new Promise((resolve) => {
      hwStageRecon.on("connect", () => {
        hwStageRecon.emit("stage-register", { systemId: "HW-Kiosk-101" });
      });
      hwStageRecon.on("stage-registered", resolve);
    });
    assert.strictEqual(hwAck2.stageId, hwAck1.stageId, "Persistent hardware identity must match on reconnection");
    assert.strictEqual(hwAck2.displayName, hwAck1.displayName, "Persistent display name must match on reconnection");
    hwStageRecon.disconnect();
    console.log(`  ✔ Hardware persistent identity verified: ${hwAck1.systemId} persistently bound to ${hwAck1.stageId} (${hwAck1.displayName}).`);

    console.log("\n=============================================");
    console.log("🎉 ALL MULTI-STAGE ORCHESTRATION TESTS PASSED!");
    console.log("=============================================\n");
  } finally {
    if (stage1) stage1.disconnect();
    if (stage2) stage2.disconnect();
    if (stage3) stage3.disconnect();
    if (controller) controller.disconnect();
    await server.stop();
  }
}

run().catch((err) => {
  console.error("❌ TEST FAILED:", err);
  process.exit(1);
});
