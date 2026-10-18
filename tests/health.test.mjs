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
  assert.equal(bridge.requests[0].signal.timeoutMs, 2000);
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
});
