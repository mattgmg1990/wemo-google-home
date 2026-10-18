import assert from "node:assert/strict";
import test from "node:test";
import { chairId, couchId, redId, chairSerial, redSerial, createBridge, device, inventory } from "./helpers/bridge.mjs";

const fields = (bridge) => bridge.requests.map((request) => request.fields);
const results = (response) => Object.fromEntries(response.payload.commands.map((command) => [command.ids[0], command]));
const command = (ids, on) => ({ devices: ids.map((id) => ({ id })), execution: [{ command: "action.devices.commands.OnOff", params: { on } }] });
const executeCommands = (bridge, commands) => bridge.google.executePayload({ requestId: "mixed-test", inputs: [{ payload: { commands } }] });

test("a failed couch does not mark confirmed chair and red commands offline", async () => {
  const bridge = createBridge();
  bridge.reply({ ok: false, error: "Device offline" }, 503);
  bridge.reply({ ok: true, device: device(chairSerial) });
  bridge.reply({ ok: true, device: device(redSerial) });
  const response = results(await bridge.execute([couchId, chairId, redId]));
  assert.equal(response[couchId].errorCode, "deviceOffline");
  assert.equal(response[chairId].status, "SUCCESS");
  assert.equal(response[redId].status, "SUCCESS");
  assert.equal(bridge.requests.length, 3);
});

test("a failed light waits for the healthy command and never caches requested state", async () => {
  const bridge = createBridge();
  bridge.reply({ ok: true, devices: inventory({ state: "off", state_value: 0 }) });
  await bridge.query();
  bridge.reply({ ok: false, error: "Connection timed out" }, 504);
  const releaseRed = bridge.deferredReply({ ok: true, device: device(redSerial) });
  let settled = false;
  const executing = bridge.execute([chairId, redId]).then((response) => { settled = true; return response; });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  releaseRed();
  const response = results(await executing);
  assert.equal(response[chairId].errorCode, "deviceOffline");
  assert.equal(response[redId].status, "SUCCESS");
  bridge.reply({ ok: true, devices: [device(chairSerial, { state: "off", state_value: 0, online: false }), device(redSerial)] });
  const state = (await bridge.query()).payload.devices;
  assert.equal(state[chairId].online, false);
  assert.equal(Object.hasOwn(state[chairId], "on"), false);
  assert.equal(state[redId].on, true);
});

test("unknown IDs and unsupported commands are isolated from valid targets", async () => {
  const bridge = createBridge();
  bridge.reply({ ok: true, device: device(chairSerial) });
  const response = results(await executeCommands(bridge, [
    command(["unknown-light", chairId], true),
    { devices: [{ id: redId }], execution: [{ command: "action.devices.commands.BrightnessAbsolute", params: { brightness: 50 } }] },
  ]));
  assert.equal(response["unknown-light"].errorCode, "deviceNotFound");
  assert.equal(response[redId].errorCode, "functionNotSupported");
  assert.equal(response[chairId].status, "SUCCESS");
  assert.equal(bridge.requests.length, 1);
});

test("mixed on/off groups retain each target's requested intent", async () => {
  const bridge = createBridge();
  bridge.reply({ ok: true, device: device(chairSerial) });
  bridge.reply({ ok: true, device: device(redSerial, { state: "off", state_value: 0 }) });
  const response = results(await executeCommands(bridge, [command([chairId], true), command([redId], false)]));
  assert.equal(response[chairId].states.on, true);
  assert.equal(response[redId].states.on, false);
  assert.deepEqual(fields(bridge), [{ action: "on", device_id: chairSerial }, { action: "off", device_id: redSerial }]);
});

test("missing targets cannot broaden a valid command to other lights", async () => {
  const bridge = createBridge();
  bridge.reply({ ok: true, device: device(chairSerial) });
  const emptyTargetOff = command([], false);
  const missingTargetOff = command([], false);
  delete missingTargetOff.devices;
  const response = results(await executeCommands(bridge, [command([chairId], true), emptyTargetOff, missingTargetOff]));
  assert.deepEqual(Object.keys(response), [chairId]);
  assert.equal(bridge.requests.length, 1);
  assert.equal((await executeCommands(bridge, [emptyTargetOff, missingTargetOff])).payload.errorCode, "protocolError");
  assert.equal(bridge.requests.length, 1);
});

test("repeated targets execute in order and return the last confirmed state", async () => {
  const bridge = createBridge();
  const releaseOn = bridge.deferredReply({ ok: true, device: device(chairSerial) });
  bridge.reply({ ok: true, device: device(chairSerial, { state: "off", state_value: 0 }) });
  const executing = executeCommands(bridge, [command([chairId], true), command([chairId], false)]);
  await new Promise(setImmediate);
  assert.equal(bridge.requests.length, 1);
  releaseOn();
  assert.equal(results(await executing)[chairId].states.on, false);
  assert.deepEqual(fields(bridge), [{ action: "on", device_id: chairSerial }, { action: "off", device_id: chairSerial }]);
});

test("all sequential operations share one 7s deadline instead of restarting timeouts", async () => {
  const bridge = createBridge();
  bridge.reply({ ok: true, device: device(chairSerial, { observedAt: bridge.now() + 4000 }) }, 200, 4000);
  bridge.reply({ ok: true, device: device(chairSerial, { observedAt: bridge.now() + 7100, state: "off", state_value: 0 }) }, 200, 3100);
  const response = results(await executeCommands(bridge, [command([chairId], true), command([chairId], false), command([chairId], true)]));
  assert.equal(response[chairId].status, "ERROR");
  assert.equal(bridge.requests.length, 2);
  assert.deepEqual(bridge.requests.map((r) => r.signal.timeoutMs), [7000, 3000]);
});

test("a hung Pi fetch is aborted at the shared deadline", async () => {
  const bridge = createBridge({ realAbort: true });
  bridge.hangingReply();
  const holdEventLoop = setInterval(() => {}, 1000);
  const began = performance.now();
  try {
    const response = await bridge.execute();
    assert.equal(response.payload.commands[0].status, "ERROR");
    assert.ok(performance.now() - began < 8000);
  } finally { clearInterval(holdEventLoop); }
});
