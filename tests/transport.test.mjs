import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createSecureServer } from "node:http2";
import { createServer as createHttpsServer } from "node:https";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as undici from "undici";

// Public, localhost-only fixtures. These are not production credentials.
const cert = readFileSync(new URL("./fixtures/transport-cert.pem", import.meta.url));
const key = readFileSync(new URL("./fixtures/transport-key.pem", import.meta.url));
const source = readFileSync(new URL("../src/lib/pi-transport.ts", import.meta.url), "utf8");

function loadTransport(t, { trustFixture = true } = {}) {
  const dispatchers = [];
  let configured;
  class TestAgent extends undici.Agent {
    constructor(options) {
      configured = options;
      super({ ...options, connect: { ...options.connect, ...(trustFixture ? { ca: cert } : {}) } });
      dispatchers.push(this);
    }
  }
  const context = vm.createContext({});
  const loadedModule = { exports: {} };
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  new vm.Script(`(function(exports, require, module) {${outputText}\n})`)
    .runInContext(context)(loadedModule.exports, (name) => {
      assert.equal(name, "undici");
      return { ...undici, Agent: TestAgent };
    }, loadedModule);
  t.after(() => Promise.all(dispatchers.map((dispatcher) => dispatcher.destroy())));
  return { fetch: loadedModule.exports.piFetch, options: configured };
}

async function startServer(t, handler, { h1Only = false } = {}) {
  const server = h1Only
    ? createHttpsServer({ key, cert }, handler)
    : createSecureServer({ key, cert, allowHTTP1: true }, handler);
  const sockets = new Set();
  const sessions = new Set();
  let tlsConnections = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("secureConnection", () => { tlsConnections++; });
  server.on("session", (session) => {
    sessions.add(session);
    // A client abort/reset is part of several fixtures.
    session.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const session of sessions) session.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    url: `https://127.0.0.1:${server.address().port}`,
    sessions,
    tlsConnections: () => tlsConnections,
  };
}

function requestOptions(signal = AbortSignal.timeout(1_500)) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Wemo-Token": "fixture-only" },
    body: new URLSearchParams({ action: "status" }),
    redirect: "error",
    signal,
  };
}

async function bodyOf(response) {
  return { status: response.status, body: await response.text() };
}

test("cold HTTP/2 light requests multiplex over one authenticated TLS connection", async (t) => {
  const received = [];
  const server = await startServer(t, (request, response) => {
    request.resume();
    received.push({ request, response });
    if (received.length === 3) {
      for (const { request: incoming, response: outgoing } of received) {
        assert.equal(incoming.httpVersion, "2.0");
        assert.equal(incoming.headers["x-wemo-token"], "fixture-only");
        outgoing.end(incoming.url);
      }
    }
  });
  const transport = loadTransport(t);
  const results = await Promise.all(["/couch", "/chair", "/red"].map((path) =>
    transport.fetch(server.url + path, requestOptions()).then(bodyOf)));
  assert.deepEqual(results.map((result) => result.body), ["/couch", "/chair", "/red"]);
  assert.equal(server.tlsConnections(), 1);
  assert.equal(server.sessions.size, 1);
  assert.equal(transport.options.allowH2, true);
  assert.equal(transport.options.connect.preferH2, true);
  assert.equal(transport.options.pingInterval, 0);
});

test("HTTP/1.1 fallback keeps healthy lights independent of a stalled first light", async (t) => {
  const received = [];
  const server = await startServer(t, (request, response) => {
    request.resume();
    received.push({ request, response });
    if (received.length === 3) {
      for (const { request: incoming, response: outgoing } of received) {
        assert.equal(incoming.httpVersion, "1.1");
        if (incoming.url !== "/slow") outgoing.end(incoming.url);
      }
    }
  }, { h1Only: true });
  const transport = loadTransport(t);
  const stop = new AbortController();
  const slow = transport.fetch(server.url + "/slow", requestOptions(stop.signal)).then(bodyOf);
  // Attach the rejection handler before the test intentionally aborts it.
  const settledSlow = slow.then(() => "unexpected success", () => "aborted");
  const healthy = await Promise.all(["/chair", "/red"].map((path) =>
    transport.fetch(server.url + path, requestOptions()).then(bodyOf)));
  assert.deepEqual(healthy.map((result) => result.body), ["/chair", "/red"]);
  assert.equal(server.tlsConnections(), 3);
  assert.equal(received.length, 3);
  stop.abort();
  assert.equal(await settledSlow, "aborted");
});

test("aborting one HTTP/2 stream preserves sibling results and does not retry POSTs", async (t) => {
  const seen = [];
  let release;
  const server = await startServer(t, (request, response) => {
    request.resume();
    seen.push(request.url);
    if (request.url === "/slow") {
      response.writeHead(200);
      response.flushHeaders();
      return;
    }
    if (request.url === "/later") release = () => response.end("later");
    else response.end("fast");
  });
  const transport = loadTransport(t);
  const stop = new AbortController();
  const slow = transport.fetch(server.url + "/slow", requestOptions(stop.signal)).then(bodyOf);
  const settledSlow = slow.then(() => "unexpected success", () => "aborted");
  const later = transport.fetch(server.url + "/later", requestOptions()).then(bodyOf);
  const fast = await transport.fetch(server.url + "/fast", requestOptions()).then(bodyOf);
  assert.equal(fast.body, "fast");
  stop.abort();
  assert.equal(await settledSlow, "aborted");
  release();
  assert.equal((await later).body, "later");
  assert.deepEqual(seen.sort(), ["/fast", "/later", "/slow"]);
  assert.equal(server.tlsConnections(), 1);
});

test("a failed transmitted HTTP/2 POST is not replayed and the next request reconnects", async (t) => {
  const seen = [];
  const server = await startServer(t, (request, response) => {
    request.resume();
    seen.push(request.url);
    if (request.url === "/disconnect") {
      request.stream.session.destroy();
      return;
    }
    response.end("reconnected");
  });
  const transport = loadTransport(t);
  await assert.rejects(transport.fetch(server.url + "/disconnect", requestOptions()).then(bodyOf));
  const response = await transport.fetch(server.url + "/next", requestOptions()).then(bodyOf);
  assert.equal(response.body, "reconnected");
  assert.deepEqual(seen, ["/disconnect", "/next"]);
  assert.equal(server.tlsConnections(), 2);
});

test("an elapsed caller deadline sends no request", async (t) => {
  let requests = 0;
  const server = await startServer(t, (_request, response) => {
    requests++;
    response.end("unexpected");
  });
  const transport = loadTransport(t);
  await assert.rejects(transport.fetch(server.url, requestOptions(AbortSignal.abort())));
  assert.equal(requests, 0);
  assert.equal(server.tlsConnections(), 0);
});

test("redirects cannot forward the Pi token", async (t) => {
  const seen = [];
  const server = await startServer(t, (request, response) => {
    request.resume();
    seen.push(request.url);
    response.writeHead(302, { location: "/forwarded" });
    response.end();
  });
  const transport = loadTransport(t);
  await assert.rejects(transport.fetch(server.url + "/redirect", requestOptions()));
  assert.deepEqual(seen, ["/redirect"]);
});

test("TLS certificate validation remains enabled", async (t) => {
  let requests = 0;
  const server = await startServer(t, (_request, response) => {
    requests++;
    response.end("unexpected");
  });
  const transport = loadTransport(t, { trustFixture: false });
  await assert.rejects(transport.fetch(server.url, requestOptions()), (error) =>
    error.cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT");
  assert.equal(requests, 0);
});
