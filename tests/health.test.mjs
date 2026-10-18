import assert from "node:assert/strict";
import test from "node:test";
import { createBridge } from "./helpers/bridge.mjs";

const healthy = { ok: true, health: { healthy: true, workerHealthy: true, registryHealthy: true } };

test("public health reports only aggregate status and checks Pi with server auth", async () => {
  const bridge = createBridge();
  bridge.reply({ ...healthy, token: "do-not-expose", devices: [{ name: "Private name" }] });
  const response = await bridge.health.GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "healthy" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(bridge.requests[0].fields, { action: "health" });
  assert.equal(bridge.requests[0].headers["X-Wemo-Token"], "test-only");
  assert.equal(bridge.requests[0].signal.timeoutMs, 5000);
});

test("unhealthy, malformed and unreachable Pi are degraded without leaking error details", async () => {
  for (const payload of [
    { ok: false, error: "secret-token / private-name" },
    { ok: true }, { ok: true, health: { ...healthy.health, workerHealthy: false } },
    { ok: true, health: { ...healthy.health, registryHealthy: false } },
    { ok: true, health: { ...healthy.health, healthy: false } },
  ]) {
    const bridge = createBridge();
    bridge.reply(payload);
    const response = await bridge.health.GET();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "degraded" });
  }
});

test("health requests dedupe and cache success or failure for only 30s", async () => {
  const bridge = createBridge();
  const release = bridge.deferredReply(healthy);
  const requests = [bridge.health.GET(), bridge.health.GET()];
  assert.equal(bridge.requests.length, 1);
  release();
  assert.deepEqual((await Promise.all(requests)).map((r) => r.status), [200, 200]);
  bridge.advanceTime(29999);
  assert.equal((await bridge.health.GET()).status, 200);
  assert.equal(bridge.requests.length, 1);
  bridge.advanceTime(1);
  bridge.reply({ ok: false, error: "Pi unavailable" }, 503);
  assert.equal((await bridge.health.GET()).status, 503);
  assert.equal((await bridge.health.GET()).status, 503);
  assert.equal(bridge.requests.length, 2);
  assert.equal(bridge.logs.length, 1, "cached failures must not duplicate diagnostics");
});

test("a healthy Pi response after 3 seconds survives a cold Funnel connection", async () => {
  const bridge = createBridge();
  bridge.reply(healthy, 200, 3000);
  const response = await bridge.health.GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "healthy" });
  assert.equal(bridge.logs.length, 0);
  assert.equal(bridge.requests.length, 1, "health checks never retry");
});

test("responses beyond 5 seconds are degraded with a sanitized timeout diagnostic", async () => {
  const bridge = createBridge();
  bridge.reply(healthy, 200, 5001);
  const response = await bridge.health.GET();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "degraded" });
  assert.equal(bridge.requests[0].signal.timeoutMs, 5000);
  assert.deepEqual(JSON.parse(JSON.stringify(bridge.logs)), [["[health] Pi check failed", {
    reason: "timeout", durationMs: 5001,
  }]]);
  assert.equal(bridge.requests.length, 1);
});

test("failure diagnostics contain only fixed categories, duration and health booleans", async () => {
  for (const payload of [
    { ok: false, error: "private-name secret-token https://private.example/ 192.168.68.50" },
    { ok: true, health: { ...healthy.health, workerHealthy: false, token: "secret-token", name: "private-name" } },
    { ok: true, health: { ...healthy.health, healthy: false, ip: "192.168.68.50" } },
    { ok: true, health: { ...healthy.health, registryHealthy: false } },
  ]) {
    const bridge = createBridge();
    const release = bridge.deferredReply(payload);
    const requests = [bridge.health.GET(), bridge.health.GET()];
    release();
    for (const response of await Promise.all(requests)) {
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { status: "degraded" });
    }
    await bridge.health.GET();
    assert.equal(bridge.logs.length, 1, "deduped and cached callers log only one failure");
    const diagnostic = bridge.logs[0][1];
    assert.equal(diagnostic.reason, payload.ok ? "pi_unhealthy" : "request_failed");
    assert.equal(diagnostic.durationMs, 0);
    assert.ok(Object.keys(diagnostic).every((key) => ["reason", "durationMs", "healthy", "workerHealthy", "registryHealthy"].includes(key)));
    assert.doesNotMatch(JSON.stringify(bridge.logs), /secret-token|private-name|https:|192\.168/);
  }
});
