import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEALTH_URL = 'https://wemo-google-home.vercel.app/api/health';
export const TIMEOUT_MS = 10_000;
const EMPTY_STATE = { version: 1, consecutiveFailures: 0, alerted: false };

function validState(value) {
  return value && value.version === 1
    && Number.isSafeInteger(value.consecutiveFailures) && value.consecutiveFailures >= 0
    && typeof value.alerted === 'boolean'
    && (!value.alerted || value.consecutiveFailures >= 3);
}

async function readState(statePath) {
  try {
    const value = JSON.parse(await readFile(statePath, 'utf8'));
    return validState(value) ? value : { ...EMPTY_STATE };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { ...EMPTY_STATE };
    throw new Error('state_read_failed');
  }
}

async function writeState(statePath, state) {
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, statePath);
  } finally { await rm(temporary, { force: true }); }
}

async function lockState(statePath) {
  const lockPath = `${statePath}.lock`;
  // A second runner fails closed rather than issuing a duplicate alert. A lock
  // left by a dead process is reclaimed, without guessing from elapsed time.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }), 'utf8');
      return async () => { await handle.close(); await rm(lockPath, { force: true }); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw new Error('state_lock_failed');
      // Serialize reclamation too, so two stale-lock readers cannot remove a
      // fresh lock established by each other. An interrupted reclamation fails
      // closed and needs its .reclaim marker removed by an operator.
      const reclaimPath = `${lockPath}.reclaim`;
      let reclaimer;
      try { reclaimer = await open(reclaimPath, 'wx', 0o600); }
      catch { throw new Error('state_busy'); }
      try {
        let pid;
        try { pid = JSON.parse(await readFile(lockPath, 'utf8')).pid; }
        catch (readError) {
          if (readError.code === 'ENOENT') continue;
          throw new Error('state_busy');
        }
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('state_busy');
        try { process.kill(pid, 0); throw new Error('state_busy'); }
        catch (probeError) {
          if (probeError.code !== 'ESRCH') throw new Error('state_busy');
        }
        await rm(lockPath, { force: true });
      } finally { await reclaimer.close(); await rm(reclaimPath, { force: true }); }
    }
  }
  throw new Error('state_busy');
}

async function probeHealth(fetchImpl, timeoutMs) {
  const started = performance.now();
  const controller = new AbortController();
  let timeout;
  const request = (async () => {
    const response = await fetchImpl(HEALTH_URL, {
      method: 'GET', redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json' }, signal: controller.signal,
    });
    if (response.status !== 200) return false;
    const text = await response.text();
    if (text.length > 4096) return false;
    const payload = JSON.parse(text);
    return payload !== null && !Array.isArray(payload) && typeof payload === 'object'
      && Object.keys(payload).length === 1 && payload.status === 'healthy';
  })();
  const deadline = new Promise((resolve) => {
    timeout = setTimeout(() => { controller.abort(); resolve(false); }, timeoutMs);
  });
  let healthy = false;
  try { healthy = await Promise.race([request, deadline]); }
  catch { healthy = false; }
  finally { clearTimeout(timeout); }
  return { healthy, latencyMs: Math.round(performance.now() - started) };
}

export async function checkHealth({ statePath, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  if (!statePath || !path.isAbsolute(statePath)) throw new Error('absolute_state_path_required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > TIMEOUT_MS) throw new Error('invalid_timeout');
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const unlock = await lockState(statePath);
  try {
    const previous = await readState(statePath);
    const probe = await probeHealth(fetchImpl, timeoutMs);
    const failures = probe.healthy ? 0 : Math.min(Number.MAX_SAFE_INTEGER, previous.consecutiveFailures + 1);
    const event = probe.healthy ? (previous.alerted ? 'recovery' : 'none')
      : failures >= 3 && !previous.alerted ? 'failure' : 'none';
    const state = {
      version: 1, consecutiveFailures: failures,
      alerted: probe.healthy ? false : previous.alerted || event === 'failure',
    };
    await writeState(statePath, state);
    return { event, consecutiveFailures: failures, latencyMs: probe.latencyMs };
  } finally { await unlock(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--state') throw new Error('usage: node check-health.mjs --state ABSOLUTE_STATE_PATH');
  console.log(JSON.stringify(await checkHealth({ statePath: args[1] })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Never include response contents, local paths, credentials or device details.
    const allowed = ['state_read_failed', 'state_lock_failed', 'state_busy', 'absolute_state_path_required'];
    console.log(JSON.stringify({ event: 'none', consecutiveFailures: null, latencyMs: null,
      error: allowed.includes(error.message) ? error.message : 'monitor_failed' }));
    process.exitCode = 1;
  });
}
