import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkHealth, HEALTH_URL, TIMEOUT_MS } from './check-health.mjs';

const healthy = () => new Response('{"status":"healthy"}', { status: 200 });
const failed = () => new Response('{"status":"degraded"}', { status: 503 });
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wemo-monitor-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, statePath: path.join(directory, 'state.json') };
}

test('initial healthy checks create state without notification', async (t) => {
  const { statePath, directory } = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const result = await checkHealth({ statePath, fetchImpl: healthy });
    assert.equal(result.event, 'none');
    assert.equal(result.consecutiveFailures, 0);
    assert.equal(typeof result.latencyMs, 'number');
  }
  assert.deepEqual(JSON.parse(await readFile(statePath)), { version: 1, consecutiveFailures: 0, alerted: false });
  assert.deepEqual(await readdir(directory), ['state.json']);
});

test('three consecutive failures alert once, ongoing failures are quiet, recovery alerts once', async (t) => {
  const { statePath } = await fixture(t);
  const events = [];
  for (let i = 0; i < 6; i++) events.push((await checkHealth({ statePath, fetchImpl: failed })).event);
  assert.deepEqual(events, ['none', 'none', 'failure', 'none', 'none', 'none']);
  assert.equal((await checkHealth({ statePath, fetchImpl: healthy })).event, 'recovery');
  assert.equal((await checkHealth({ statePath, fetchImpl: healthy })).event, 'none');
  assert.equal((await checkHealth({ statePath, fetchImpl: failed })).consecutiveFailures, 1);
});

test('transient failures reset without a false recovery message', async (t) => {
  const { statePath } = await fixture(t);
  await checkHealth({ statePath, fetchImpl: failed });
  await checkHealth({ statePath, fetchImpl: failed });
  assert.equal((await checkHealth({ statePath, fetchImpl: healthy })).event, 'none');
  assert.equal((await checkHealth({ statePath, fetchImpl: failed })).consecutiveFailures, 1);
});

test('corrupt and inconsistent state reset conservatively without claiming recovery', async (t) => {
  const { statePath } = await fixture(t);
  for (const raw of ['{partial', 'null', '{"version":1,"consecutiveFailures":0,"alerted":true}', '{"version":1,"consecutiveFailures":-1,"alerted":false}']) {
    await writeFile(statePath, raw);
    assert.equal((await checkHealth({ statePath, fetchImpl: healthy })).event, 'none');
  }
  await writeFile(statePath, '{partial');
  assert.equal((await checkHealth({ statePath, fetchImpl: failed })).consecutiveFailures, 1);
});

test('only HTTP200 JSON exactly {status:healthy} is healthy', async (t) => {
  const { statePath } = await fixture(t);
  for (const body of ['<html>login</html>', '{partial', 'null', 'true', '[{"status":"healthy"}]', '{}', '{"status":"HEALTHY"}', '{"status":"healthy","extra":true}']) {
    const result = await checkHealth({ statePath, fetchImpl: async () => new Response(body) });
    assert.ok(result.consecutiveFailures > 0, body);
    await checkHealth({ statePath, fetchImpl: healthy });
  }
  assert.equal((await checkHealth({ statePath, fetchImpl: async () => new Response('{"status":"healthy"}', { status: 201 }) })).consecutiveFailures, 1);
});

test('request is GET only to the fixed public endpoint with no credentials or redirects', async (t) => {
  const { statePath } = await fixture(t);
  assert.equal(TIMEOUT_MS, 10000);
  await checkHealth({ statePath, fetchImpl: async (url, options) => {
    assert.equal(url, HEALTH_URL);
    assert.equal(url, 'https://wemo-google-home.vercel.app/api/health');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    assert.equal(options.body, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return healthy();
  } });
});

test('timeout counts once and aborts even if the transport does not resolve', async (t) => {
  const { statePath } = await fixture(t);
  let signal;
  const started = performance.now();
  const result = await checkHealth({ statePath, timeoutMs: 20, fetchImpl: async (_, options) => {
    signal = options.signal;
    return await new Promise(() => {});
  } });
  assert.equal(result.consecutiveFailures, 1);
  assert.equal(signal.aborted, true);
  assert.ok(performance.now() - started < 500);
});

test('network errors do not expose error or response details', async (t) => {
  const { statePath } = await fixture(t);
  const result = await checkHealth({ statePath, fetchImpl: async () => { throw new Error('sensitive detail'); } });
  assert.deepEqual(Object.keys(result).sort(), ['consecutiveFailures', 'event', 'latencyMs']);
  assert.equal(result.event, 'none');
  assert.equal(result.consecutiveFailures, 1);
});

test('concurrent invocations fail closed instead of producing duplicate notifications', async (t) => {
  const { statePath } = await fixture(t);
  await checkHealth({ statePath, fetchImpl: failed });
  await checkHealth({ statePath, fetchImpl: failed });
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const first = checkHealth({ statePath, fetchImpl: async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
    return failed();
  } });
  await ready;
  await assert.rejects(checkHealth({ statePath, fetchImpl: failed }), /state_busy/);
  release();
  assert.equal((await first).event, 'failure');
  assert.equal((await checkHealth({ statePath, fetchImpl: failed })).event, 'none');
});

test('state path must be explicit and absolute', async () => {
  await assert.rejects(checkHealth({ statePath: 'state.json', fetchImpl: healthy }), /absolute_state_path_required/);
});
