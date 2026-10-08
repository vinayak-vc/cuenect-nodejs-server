/**
 * Automated test for the relay's stage authentication (B-009), control-lock enforcement (B-016) and the
 * exactly-once delivery contract (B-012).
 *
 *  1. A login that only claims to be the stage (name "Unity_Stage" or role "stage") is a controller.
 *  2. A login with the secret is a stage; a wrong secret is not.
 *  3. stage-register without the secret or a stage login is refused and creates no stage.
 *  4. CUENECT_ALLOW_LEGACY_STAGE_LOGIN-style option restores the old behaviour (transition aid).
 *  5. The lock holder's commands reach the stage; another controller's mutating commands (direct and
 *     dispatch-command) do not; its read-only traffic still does; an unclaimed stage stays open.
 *  6. One direct mutating event reaches a registered stage exactly once; so does one dispatch-command to '*'.
 *
 * Run: node test/testStageSecurityAndWireContract.js
 */

const assert = require("assert");
let ioClient;
try {
  ioClient = require("socket.io-client").io;
} catch (e) {
  ioClient = require("c:/ReactApp/cuenect-webfront-offline/node_modules/socket.io-client").io;
}
const { SignalingServer } = require("../src/signalingServer");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(port) {
  return new Promise((resolve) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false });
    socket.on("connect", () => resolve(socket));
  });
}

function login(socket, payload) {
  return new Promise((resolve) => {
    socket.once("login_response", resolve);
    socket.emit("login", payload);
  });
}

/** Counts how many times `eventName` arrives on `socket`. */
function counter(socket, eventName) {
  const state = { count: 0, last: undefined };
  socket.on(eventName, (data) => {
    state.count++;
    state.last = data;
  });
  return state;
}

async function run() {
  const port = 9233;
  const server = new SignalingServer(port, null, { persistStageSecret: false });
  await server.start();
  const open = [];
  const track = (s) => {
    open.push(s);
    return s;
  };

  try {
    // ---- 1 and 2: who gets the stage role ----------------------------------------------------------
    console.log("▶ [Test 1] A login that only claims the stage role is a controller...");
    const claimant = track(await connect(port));
    await login(claimant, "Unity_Stage");
    assert.strictEqual(server.roles.get(claimant.id), "controller", "bare Unity_Stage name must not be a stage");
    const claimant2 = track(await connect(port));
    await login(claimant2, { name: "Evil", role: "stage" });
    assert.strictEqual(server.roles.get(claimant2.id), "controller", "role:'stage' without a secret must not be a stage");
    const wrong = track(await connect(port));
    await login(wrong, { name: "Unity_Stage", role: "stage", secret: "not-the-secret" });
    assert.strictEqual(server.roles.get(wrong.id), "controller", "a wrong secret must not be a stage");
    console.log("  ✔ Three false claims stayed controllers.");

    console.log("▶ [Test 2] A login with the secret is a stage...");
    const stage = track(await connect(port));
    await login(stage, { name: "Stage A", role: "stage", stageId: "stage_sec_a", secret: server.stageSecret });
    assert.strictEqual(server.roles.get(stage.id), "stage");
    assert.ok(server.stages.has("stage_sec_a"), "the stage must be registered");
    console.log("  ✔ Secret accepted, stage registered.");

    // ---- 3: stage-register -------------------------------------------------------------------------
    console.log("▶ [Test 3] stage-register without the secret is refused...");
    const before = server.stages.size;
    const intruder = track(await connect(port));
    intruder.emit("stage-register", { stageId: "stage_intruder", displayName: "Intruder" });
    await wait(250);
    assert.strictEqual(server.stages.size, before, "no stage may be created");
    assert.ok(!server.stages.has("stage_intruder"));
    assert.notStrictEqual(server.roles.get(intruder.id), "stage");
    const bearer = track(await connect(port));
    bearer.emit("stage-register", { stageId: "stage_sec_b", displayName: "B", secret: server.stageSecret });
    await wait(250);
    assert.ok(server.stages.has("stage_sec_b"), "stage-register with the secret works");
    console.log("  ✔ Refused without, accepted with the secret.");

    // ---- 4: legacy switch ----------------------------------------------------------------------------
    console.log("▶ [Test 4] allowLegacyStageLogin restores the old login (transition aid)...");
    const legacyServer = new SignalingServer(port + 1, null, { persistStageSecret: false, allowLegacyStageLogin: true });
    await legacyServer.start();
    const legacy = track(await connect(port + 1));
    await login(legacy, "Unity_Stage");
    assert.strictEqual(legacyServer.roles.get(legacy.id), "stage");
    legacy.close();
    await legacyServer.stop?.();
    console.log("  ✔ Old behaviour only behind the explicit switch.");

    // ---- 5 and 6: control lock and exactly-once ------------------------------------------------------
    console.log("▶ [Test 5] Control lock is enforced by the relay...");
    const received = counter(stage, "hologram-asset-action");
    const model = counter(stage, "hologram-model-action");
    const message = counter(stage, "message");
    // The earlier controller sockets are still connected: drop them so the roles are unambiguous.
    for (const s of [claimant, claimant2, wrong, intruder]) s.close();
    await wait(300);
    server.controlHolder = null;

    const holder = track(await connect(port));
    await login(holder, { name: "Operator One", role: "controller" });
    const other = track(await connect(port));
    await login(other, { name: "Operator Two", role: "controller" });
    assert.strictEqual(server.controlHolder, holder.id, "the first controller holds the lock");

    holder.emit("hologram-asset-action", { action: "holder-direct" });
    await wait(250);
    assert.strictEqual(received.count, 1, "holder command reaches the stage");

    other.emit("hologram-asset-action", { action: "other-direct" });
    other.emit("dispatch-command", { targets: "*", targetEvent: "hologram-asset-action", data: { action: "other-dispatch" } });
    other.emit("hologram-model-action", { action: "rotate" });
    await wait(300);
    assert.strictEqual(received.count, 1, "an observer's mutating commands (direct and dispatched) are dropped");
    assert.strictEqual(model.count, 0, "so is a model action");

    other.emit("message", "ReqAsset");
    await wait(250);
    assert.ok(!server.isBlockedByControlLock({ id: other.id }, "message"), "read-only traffic is never blocked");

    other.emit("control-request");
    await wait(250);
    assert.strictEqual(server.controlHolder, other.id);
    other.emit("hologram-asset-action", { action: "other-after-request" });
    await wait(250);
    assert.strictEqual(received.count, 2, "after taking control the second operator can drive the stage");
    holder.emit("hologram-asset-action", { action: "old-holder-now-blocked" });
    await wait(250);
    assert.strictEqual(received.count, 2, "and the previous holder is now the observer");

    other.emit("control-release");
    await wait(250);
    assert.strictEqual(server.controlHolder, null);
    holder.emit("hologram-asset-action", { action: "unclaimed" });
    await wait(250);
    assert.strictEqual(received.count, 3, "an unclaimed stage is open to everyone");
    console.log("  ✔ Holder passes, observer dropped (direct and dispatched), read-only passes, release reopens.");

    console.log("▶ [Test 6] Exactly one delivery per command...");
    server.controlHolder = holder.id;
    const base = received.count;
    holder.emit("hologram-asset-action", { action: "once-direct" });
    await wait(300);
    assert.strictEqual(received.count, base + 1, "a direct event is delivered once");
    holder.emit("dispatch-command", { targets: "*", targetEvent: "hologram-asset-action", data: { action: "once-dispatch" } });
    await wait(300);
    assert.strictEqual(received.count, base + 2, "a dispatch-command to '*' is delivered once");
    console.log("  ✔ One delivery each.");

    console.log("▶ [Test 7] Diagnostics come from the stage only; pings reach the stage and the answer reaches the asker...");
    const reports = counter(holder, "stage-diagnostics");
    const pongs = counter(holder, "stage-pong");
    const pings = counter(stage, "stage-ping");
    stage.emit("stage-diagnostics", { fps: 60, frameMs: 16.6 });
    other.emit("stage-diagnostics", { fps: 1, frameMs: 999 });
    other.emit("stage-pong", { id: "forged" });
    await wait(300);
    assert.strictEqual(reports.count, 1, "only the stage's report is relayed");
    assert.strictEqual(reports.last.fps, 60);
    assert.strictEqual(pongs.count, 0, "a controller cannot forge a pong");
    holder.emit("stage-ping", { id: "p1" });
    await wait(250);
    assert.strictEqual(pings.count, 1, "a ping reaches the stage");
    stage.emit("stage-pong", { id: "p1" });
    await wait(250);
    assert.strictEqual(pongs.count, 1);
    assert.strictEqual(pongs.last.id, "p1");
    console.log("  ✔ Reports and pongs only from the stage; pings relayed.");

    console.log("\n=============================================");
    console.log("🎉 STAGE SECURITY AND WIRE CONTRACT TESTS PASSED");
    console.log("=============================================");
  } finally {
    for (const s of open) {
      try {
        s.close();
      } catch (e) {
        /* already closed */
      }
    }
    if (server.httpServer) server.httpServer.close();
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
}

run().catch((err) => {
  console.error("✘ TEST FAILED:", err.message);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 300);
});
