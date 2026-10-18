import assert from "node:assert/strict";
import test from "node:test";
import { chairId, couchId, redId, chairSerial, couchSerial, redSerial, createBridge, device, inventory, startTime } from "./helpers/bridge.mjs";

const fields = (bridge) => bridge.requests.map((request) => request.fields);
const firstCommand = (response) => response.payload.commands[0];

test("SYNC preserves all existing Google IDs", () => {
  const bridge = createBridge();
  assert.deepEqual(Array.from(bridge.google.syncPayload("sync").payload.devices, (d) => d.id).sort(), [chairId, couchId, redId].sort());
});

test("cold commands address permanent serial directly, with no status or SSDP roundtrip", async () => {
  const bridge = createBridge();
  bridge.reply({ ok: true, device: device(chairSerial) });
  assert.equal(firstCommand(await bridge.execute()).status, "SUCCESS");
  assert.deepEqual(fields(bridge), [{ action: "on", device_id: chairSerial }]);
  assert.equal(bridge.requests[0].redirect, "error");
  assert.equal(bridge.requests[0].headers["X-Wemo-Token"], "test-only");
});

test("IP changes, reused IPs and identical friendly names never change identity", async () => {
  const bridge = createBridge();
  bridge.reply({ ok: true, devices: inventory() });
  const states = (await bridge.query()).payload.devices;
  assert.equal(states[chairId].online, true);
  assert.equal(states[couchId].online, true);
  bridge.reply({ ok: true, device: device(chairSerial, { ip: "192.168.68.99", name: "Renamed plug" }) });
  assert.equal(firstCommand(await bridge.execute()).status, "SUCCESS");
  assert.deepEqual(fields(bridge)[1], { action: "on", device_id: chairSerial });
});

test("missing or duplicated serials and identity disagreement fail closed", async () => {
  for (const devices of [
    inventory().slice(0, 2),
    [...inventory(), device(chairSerial)],
    [...inventory().slice(0, 2), device(chairSerial, { id: couchSerial })],
    [{ name: "Light Behind the Chair", ip: "192.168.68.50", state: "on", state_value: 1 }],
  ]) {
    const bridge = createBridge();
    bridge.reply({ ok: true, devices });
    assert.deepEqual(JSON.parse(JSON.stringify((await bridge.query()).payload.devices[chairId])), { online: false });
  }
});

test("offline, unknown, old, future and contradictory observations are not online", async () => {
  for (const overrides of [
    { online: false }, { observedAt: null }, { observedAt: startTime - 30001 },
    { observedAt: startTime + 5001 }, { state: null, state_value: null },
    { state: "on", state_value: 0 },
  ]) {
    const bridge = createBridge();
    bridge.reply({ ok: true, devices: [device(chairSerial, overrides)] });
    assert.deepEqual(JSON.parse(JSON.stringify((await bridge.query()).payload.devices[chairId])), { online: false });
  }
});

test("cached status is bounded by both cache TTL and actual observation time", async () => {
  const bridge = createBridge();
  bridge.reply({ ok: true, devices: inventory({ observedAt: startTime - 29000 }) });
  assert.equal((await bridge.query()).payload.devices[chairId].online, true);
  bridge.advanceTime(1001);
  assert.equal((await bridge.query()).payload.devices[chairId].online, false);
  assert.equal(bridge.requests.length, 1);
  bridge.advanceTime(2000);
  bridge.reply({ ok: true, devices: inventory({ observedAt: bridge.now() }) });
  assert.equal((await bridge.query()).payload.devices[chairId].online, true);
  assert.equal(bridge.requests.length, 2);
});

test("expired healthy inventory never becomes an indefinitely stale fallback", async () => {
  const bridge = createBridge();
  bridge.reply({ ok: true, devices: inventory() });
  await bridge.query();
  bridge.advanceTime(3001);
  bridge.reply({ ok: false, error: "Pi unavailable" }, 503);
  const result = (await bridge.query()).payload.devices;
  assert.equal(result[chairId].online, false);
  assert.equal(Object.hasOwn(result[chairId], "on"), false);
  bridge.reply({ ok: true, devices: inventory({ observedAt: bridge.now() }) });
  assert.equal((await bridge.query()).payload.devices[chairId].online, true);
});

test("command success requires matching serial, desired state and fresh confirmation", async () => {
  for (const overrides of [
    { id: redSerial, serial: redSerial }, { id: redSerial }, { online: false },
    { state: "off", state_value: 0 }, { observedAt: startTime - 5001 },
  ]) {
    const bridge = createBridge();
    bridge.reply({ ok: true, device: device(chairSerial, overrides) });
    assert.equal(firstCommand(await bridge.execute()).status, "ERROR");
    assert.equal(bridge.requests.length, 1);
  }
});

test("command responses do not manufacture or extend a full inventory cache", async () => {
  const bridge = createBridge();
  bridge.reply({ ok: true, device: device(chairSerial) });
  await bridge.execute();
  bridge.reply({ ok: true, devices: inventory() });
  assert.equal((await bridge.pi.getPiDevices()).length, 3);
  bridge.advanceTime(2000);
  bridge.reply({ ok: true, device: device(couchSerial, { observedAt: bridge.now() }) });
  await bridge.pi.setPiDevice(couchSerial, "on");
  await bridge.pi.getPiDevices();
  assert.equal(bridge.requests.length, 3);
  bridge.advanceTime(1001);
  bridge.reply({ ok: true, devices: inventory({ observedAt: bridge.now() }) });
  await bridge.pi.getPiDevices();
  assert.equal(bridge.requests.length, 4);
});
