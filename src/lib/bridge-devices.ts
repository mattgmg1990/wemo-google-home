import { deviceConfigJson } from "@/lib/env";
import { parseDeviceConfigJson, type BridgeDevice } from "@/lib/device-config";

export type { BridgeDevice } from "@/lib/device-config";

export function configuredDevices(): BridgeDevice[] {
  return parseDeviceConfigJson(deviceConfigJson());
}

export function safeConfiguredDevices():
  | {
      devices: BridgeDevice[];
      ok: true;
    }
  | {
      devices: [];
      error: string;
      ok: false;
    } {
  try {
    return {
      devices: configuredDevices(),
      ok: true,
    };
  } catch (error) {
    return {
      devices: [],
      error: error instanceof Error ? error.message : "Unknown device configuration error.",
      ok: false,
    };
  }
}
