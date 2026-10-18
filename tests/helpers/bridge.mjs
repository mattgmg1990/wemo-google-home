import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const startTime = 1_800_000_000_000;
export const chairId = "wemo-light-behind-the-chair";
export const couchId = "wemo-light-behind-the-couch";
export const redId = "wemo-small-red-light";
export const chairSerial = "221633K0101A1F";
export const couchSerial = "221734K0103D82";
export const redSerial = "221741K01064DC";
export const device = (serial, overrides = {}) => ({
  id: serial, serial, ip: "192.168.68.123", name: "WeMo Switch",
  state: "on", state_value: 1, online: true, observedAt: startTime, ...overrides,
});
export const inventory = (overrides = {}) => [couchSerial, redSerial, chairSerial].map((serial) => device(serial, overrides));

// Execute actual modules with isolated caches and fake time/HTTP. No real secrets or lights.
export function createBridge({ realAbort = false } = {}) {
  let now = startTime;
  const replies = [];
  const requests = [];
  const context = vm.createContext({
    URLSearchParams, URL, Response,
    AbortSignal: realAbort ? AbortSignal : { timeout(ms) { return { timeoutMs: ms }; } },
    Date: class extends Date { static now() { return now; } },
    console: { info() {}, warn() {}, error() {} },
    process: { env: { PI_WEBHOOK_URL: "https://pi.example.test/", PI_WEBHOOK_TOKEN: "test-only", GOOGLE_AGENT_USER_ID: "test-user" } },
    async fetch(url, options) {
      requests.push({ url, ...options, fields: Object.fromEntries(options.body) });
      if (replies.length === 0) throw new Error("Unexpected HTTP request");
      const { payload, status, elapsed, gate, hanging } = replies.shift();
      if (hanging) return await new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
      if (gate) await gate;
      now += elapsed;
      return new Response(JSON.stringify(payload), { status });
    },
  });
  const modules = new Map();
  function loadModule(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const loadedModule = { exports: {} };
    modules.set(filename, loadedModule);
    const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      fileName: filename,
    });
    function require(specifier) {
      if (!specifier.startsWith("@/")) throw new Error(`Unexpected module ${specifier}`);
      return loadModule(path.join(repositoryRoot, "src", `${specifier.slice(2)}.ts`));
    }
    new vm.Script(`(function(exports, require, module) {${outputText}\n})`, { filename })
      .runInContext(context)(loadedModule.exports, require, loadedModule);
    return loadedModule.exports;
  }
  const google = loadModule(path.join(repositoryRoot, "src/lib/google-home.ts"));
  const pi = loadModule(path.join(repositoryRoot, "src/lib/pi.ts"));
  const health = loadModule(path.join(repositoryRoot, "src/app/api/health/route.ts"));
  return {
    google, pi, health, requests,
    now: () => now,
    reply(payload, status = 200, elapsed = 0) { replies.push({ payload, status, elapsed }); },
    hangingReply() { replies.push({ hanging: true }); },
    deferredReply(payload, status = 200) {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      replies.push({ payload, status, elapsed: 0, gate });
      return release;
    },
    advanceTime(milliseconds) { now += milliseconds; },
    async query(ids = [chairId, couchId, redId]) {
      return google.queryPayload({ requestId: "query-test", inputs: [{ payload: { devices: ids.map((id) => ({ id })) } }] });
    },
    async execute(ids = [chairId], on = true) {
      return google.executePayload({ requestId: "execute-test", inputs: [{ payload: { commands: [{
        devices: ids.map((id) => ({ id })), execution: [{ command: "action.devices.commands.OnOff", params: { on } }],
      }] } }] });
    },
  };
}
