import assert from "node:assert/strict";
import test from "node:test";
import { createBridge, inventory } from "./helpers/bridge.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const states = (response) => Object.values(response.payload.devices);

test("a fresh inventory arriving after 3 seconds keeps all lights online and remains cached", async () => {
  const bridge = createBridge();
  const began = bridge.now();
  bridge.reply({ ok: true, devices: inventory() }, 200, 3000);
  assert.ok(states(await bridge.query()).every((state) => state.online && state.on));
  assert.equal(bridge.now() - began, 3000, "success returns as soon as the response arrives");
  assert.equal(bridge.requests[0].signal.timeoutMs, 5000);
  assert.deepEqual(bridge.requests[0].fields, { action: "status" });
  assert.ok(states(await bridge.query()).every((state) => state.online));
  assert.equal(bridge.requests.length, 1, "no retry or extra request on the cached fast path");
  assert.equal(bridge.logs.length, 0);
});

test("an inventory arriving beyond 5 seconds fails closed without using an expired snapshot", async () => {
  const bridge = createBridge();
  bridge.reply({ ok: true, devices: inventory() });
  await bridge.query();
  bridge.advanceTime(3001);
  bridge.reply({ ok: true, devices: inventory({ observedAt: bridge.now() }) }, 200, 5001);
  assert.ok(states(await bridge.query()).every((state) => !state.online && !Object.hasOwn(state, "on")));
  assert.equal(bridge.requests.length, 2, "the failed request is not retried");
  assert.deepEqual(plain(bridge.logs), [["[query] Pi status check failed", {
    reason: "timeout", durationMs: 5001,
  }]]);
});

test("a hung inventory fetch is aborted within the 5-second query budget", async () => {
  const bridge = createBridge({ realAbort: true });
  bridge.hangingReply();
  const holdEventLoop = setInterval(() => {}, 1000);
  const began = performance.now();
  try {
    assert.ok(states(await bridge.query()).every((state) => !state.online));
    const elapsed = performance.now() - began;
    assert.ok(elapsed >= 4900 && elapsed < 6000, `query completed in ${elapsed} ms`);
    assert.equal(bridge.requests.length, 1);
    assert.equal(bridge.logs[0][1].reason, "timeout");
  } finally { clearInterval(holdEventLoop); }
});

test("status failure logs never copy transport errors, private payloads or device identifiers", async () => {
  const secret = "secret-token private-name https://private.example/ 192.168.68.50 221633K0101A1F";
  for (const setup of [
    (bridge) => bridge.rejectedReply(new Error(secret)),
    (bridge) => bridge.reply({ ok: false, error: secret }, 503),
    (bridge) => bridge.reply({ ok: true, devices: secret }),
  ]) {
    const bridge = createBridge();
    setup(bridge);
    const response = await bridge.query();
    assert.ok(states(response).every((state) => !state.online));
    assert.deepEqual(plain(bridge.logs), [["[query] Pi status check failed", {
      reason: "request_failed", durationMs: 0,
    }]]);
    assert.doesNotMatch(JSON.stringify([bridge.logs, response]), /secret-token|private-name|https:|192\.168|221633K0101A1F/);
  }
});

test("concurrent failed queries log once and a later healthy request can recover", async () => {
  const bridge = createBridge();
  const release = bridge.deferredReply({ ok: false, error: "unavailable" }, 503);
  const queries = [bridge.query(), bridge.query()];
  assert.equal(bridge.requests.length, 1);
  release();
  for (const response of await Promise.all(queries)) {
    assert.ok(states(response).every((state) => !state.online));
  }
  assert.equal(bridge.logs.length, 1);
  bridge.reply({ ok: true, devices: inventory() });
  assert.ok(states(await bridge.query()).every((state) => state.online));
  assert.equal(bridge.requests.length, 2);
  assert.equal(bridge.logs.length, 1);
});
