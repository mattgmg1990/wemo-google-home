import { piWebhookToken, piWebhookUrl } from "@/lib/env";

export type PiDevice = {
  id: string;
  serial: string;
  ip: string | null;
  name: string;
  state: "off" | "on" | null;
  state_value: number | null;
  online: boolean;
  observedAt: number | null;
  error?: string;
};

type PiResponse = {
  device?: PiDevice;
  devices?: PiDevice[];
  error?: string;
  ok?: boolean;
  health?: { healthy?: boolean; workerHealthy?: boolean; registryHealthy?: boolean };
};

export const MAX_STATE_AGE_MS = 30_000;
export const EXECUTE_BUDGET_MS = 7_000;
const QUERY_TIMEOUT_MS = 2_500;
const STATUS_CACHE_TTL_MS = 3_000;
const HEALTH_TIMEOUT_MS = 5_000;
const HEALTH_CACHE_TTL_MS = 30_000;
const CLOCK_SKEW_MS = 5_000;

let statusCache: { devices: PiDevice[]; expiresAt: number } | null = null;
let statusInFlight: Promise<PiDevice[]> | null = null;
let healthCache: { healthy: boolean; expiresAt: number } | null = null;
let healthInFlight: Promise<boolean> | null = null;

export function deviceIsFresh(device: PiDevice): boolean {
  return typeof device.observedAt === "number" && Number.isFinite(device.observedAt)
    && device.observedAt > 0
    && device.observedAt <= Date.now() + CLOCK_SKEW_MS
    && Date.now() - device.observedAt <= MAX_STATE_AGE_MS
    && device.online === true
    && (device.state === "on" || device.state === "off")
    && device.state_value === (device.state === "on" ? 1 : 0);
}

async function callPi({ action, serial, deadline }: {
  action: "off" | "on" | "status" | "health";
  serial?: string;
  deadline: number;
}): Promise<PiResponse> {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) throw new Error("Pi request deadline exceeded.");
  const body = new URLSearchParams({ action });
  if (serial) body.set("device_id", serial);
  const response = await fetch(piWebhookUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Wemo-Token": piWebhookToken(),
    },
    body,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(remaining),
  });
  const text = await response.text();
  if (Date.now() > deadline) throw new Error("Pi request deadline exceeded.");
  let payload: PiResponse;
  try { payload = JSON.parse(text) as PiResponse; }
  catch { throw new Error(`Pi webhook returned a non-JSON response (${response.status}).`); }
  if (!response.ok || payload?.ok !== true) {
    throw new Error(`Pi webhook failed (${response.status}).`);
  }
  return payload;
}

export async function getPiDevices(): Promise<PiDevice[]> {
  if (statusCache && Date.now() < statusCache.expiresAt) return statusCache.devices;
  if (statusInFlight) return statusInFlight;
  statusInFlight = (async () => {
    const payload = await callPi({ action: "status", deadline: Date.now() + QUERY_TIMEOUT_MS });
    if (!Array.isArray(payload.devices)) throw new Error("Pi returned no device inventory.");
    const devices = payload.devices.filter((device) => device != null && typeof device === "object");
    statusCache = { devices, expiresAt: Date.now() + STATUS_CACHE_TTL_MS };
    return devices;
  })();
  try { return await statusInFlight; }
  finally { statusInFlight = null; }
}

export async function setPiDevice(serial: string, state: "off" | "on", deadline = Date.now() + EXECUTE_BUDGET_MS): Promise<PiDevice> {
  const startedAt = Date.now();
  try {
    const payload = await callPi({ action: state, serial, deadline });
    const device = payload.device;
    if (!device || device.id !== serial || device.serial !== serial
      || !deviceIsFresh(device) || device.state !== state
      || device.observedAt! < startedAt - CLOCK_SKEW_MS) {
      throw new Error("Pi did not confirm the requested device and state.");
    }
    // A command confirms one device only. Do not create or extend an inventory.
    if (statusCache) statusCache.devices = statusCache.devices.map((known) =>
      known.id === serial && known.serial === serial ? device : known);
    return device;
  } catch (error) {
    // A failed command must not be hidden by an earlier healthy snapshot.
    statusCache = null;
    throw error;
  }
}

export async function piIsHealthy(): Promise<boolean> {
  if (healthCache && Date.now() < healthCache.expiresAt) return healthCache.healthy;
  if (healthInFlight) return healthInFlight;
  healthInFlight = (async () => {
    const startedAt = Date.now();
    let healthy = false;
    let reason: "timeout" | "request_failed" | "pi_unhealthy" = "request_failed";
    let details: { healthy: boolean; workerHealthy: boolean; registryHealthy: boolean } | undefined;
    try {
      const payload = await callPi({ action: "health", deadline: Date.now() + HEALTH_TIMEOUT_MS });
      const status = payload.health;
      if (typeof status?.healthy === "boolean" && typeof status.workerHealthy === "boolean"
        && typeof status.registryHealthy === "boolean") {
        details = { healthy: status.healthy, workerHealthy: status.workerHealthy,
          registryHealthy: status.registryHealthy };
        healthy = status.healthy && status.workerHealthy && status.registryHealthy;
        reason = "pi_unhealthy";
      }
    } catch (error) {
      const failure = error as { name?: unknown; message?: unknown } | null;
      if (failure?.name === "TimeoutError" || failure?.name === "AbortError"
        || failure?.message === "Pi request deadline exceeded.") reason = "timeout";
    }
    if (!healthy) {
      // Only fixed categories, duration and explicitly selected booleans are
      // logged. Never copy Pi error text, URLs, identities or credentials.
      console.warn("[health] Pi check failed", {
        reason, durationMs: Date.now() - startedAt, ...details,
      });
    }
    healthCache = { healthy, expiresAt: Date.now() + HEALTH_CACHE_TTL_MS };
    return healthy;
  })();
  try { return await healthInFlight; }
  finally { healthInFlight = null; }
}
