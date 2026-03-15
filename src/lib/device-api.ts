import { deviceApiToken, deviceApiUrl } from "@/lib/env";

export type LocalApiDevice = {
  id: string;
  name: string;
  online?: boolean;
  state: "off" | "on";
};

type LocalApiResponse = {
  device?: LocalApiDevice;
  devices?: LocalApiDevice[];
  error?: string;
  ok?: boolean;
};

const DEVICE_API_TIMEOUT_MS = 20_000;
const STATUS_CACHE_TTL_MS = 15_000;

let statusCache:
  | {
      devices: LocalApiDevice[];
      expiresAt: number;
    }
  | null = null;
let statusInFlight: Promise<LocalApiDevice[]> | null = null;

function cacheDevices(devices: LocalApiDevice[]): LocalApiDevice[] {
  statusCache = {
    devices,
    expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
  };

  return devices;
}

function cachedDevices(): LocalApiDevice[] | null {
  if (statusCache === null) {
    return null;
  }

  if (Date.now() <= statusCache.expiresAt) {
    return statusCache.devices;
  }

  return null;
}

async function callDeviceApi({
  action,
  deviceId,
}: {
  action: "off" | "on" | "status";
  deviceId?: string;
}): Promise<LocalApiResponse> {
  const response = await fetch(deviceApiUrl(), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${deviceApiToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action,
      ...(deviceId ? { deviceId } : {}),
    }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(DEVICE_API_TIMEOUT_MS),
  });

  const text = await response.text();
  let payload: LocalApiResponse;

  try {
    payload = JSON.parse(text) as LocalApiResponse;
  } catch {
    throw new Error(`Device API returned a non-JSON response (${response.status}).`);
  }

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? `Device API failed (${response.status}).`);
  }

  return payload;
}

export async function getLocalDevices(): Promise<LocalApiDevice[]> {
  const cached = cachedDevices();
  if (cached !== null) {
    return cached;
  }

  if (statusInFlight !== null) {
    return statusInFlight;
  }

  statusInFlight = (async () => {
    try {
      const payload = await callDeviceApi({ action: "status" });
      return cacheDevices(Array.isArray(payload.devices) ? payload.devices : []);
    } catch (error) {
      if (statusCache !== null) {
        console.warn("[device-api] status fell back to stale cache", {
          cacheAgeMs: Math.max(Date.now() - (statusCache.expiresAt - STATUS_CACHE_TTL_MS), 0),
          error: error instanceof Error ? error.message : "unknown error",
        });
        return statusCache.devices;
      }

      throw error;
    }
  })();

  try {
    return await statusInFlight;
  } finally {
    statusInFlight = null;
  }
}

export async function setLocalDevice(deviceId: string, state: "off" | "on"): Promise<LocalApiDevice> {
  const payload = await callDeviceApi({ action: state, deviceId });
  const device = payload.device ?? payload.devices?.[0];
  if (!device) {
    throw new Error(`Device API did not return a device for "${deviceId}".`);
  }

  const currentDevices = cachedDevices() ?? [];
  const nextDevices = currentDevices.filter((entry) => entry.id !== deviceId);
  nextDevices.push(device);
  cacheDevices(nextDevices);

  return device;
}
