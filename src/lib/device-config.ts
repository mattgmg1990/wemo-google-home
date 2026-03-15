const DEFAULT_DEVICE_TYPE = "action.devices.types.OUTLET";
const DEVICE_TYPE_PREFIX = "action.devices.types.";

export type BridgeDevice = {
  id: string;
  localId: string;
  name: string;
  nicknames: string[];
  roomHint?: string;
  type: string;
};

type RawBridgeDevice = {
  id?: unknown;
  localId?: unknown;
  name?: unknown;
  nicknames?: unknown;
  roomHint?: unknown;
  type?: unknown;
};

function readString(value: unknown, fieldName: string, index: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Device ${index + 1} must include a non-empty "${fieldName}" string.`);
  }

  return value.trim();
}

function readOptionalString(value: unknown, fieldName: string, index: number): string | undefined {
  if (value == null) {
    return undefined;
  }

  return readString(value, fieldName, index);
}

function readNicknames(value: unknown, index: number): string[] {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Device ${index + 1} must use an array of strings for "nicknames".`);
  }

  return [...new Set(value.map((entry) => readString(entry, "nicknames[]", index)))];
}

function readDeviceType(value: unknown, index: number): string {
  if (value == null) {
    return DEFAULT_DEVICE_TYPE;
  }

  const type = readString(value, "type", index);
  if (!type.startsWith(DEVICE_TYPE_PREFIX)) {
    throw new Error(
      `Device ${index + 1} must use a Google device type like "${DEFAULT_DEVICE_TYPE}".`,
    );
  }

  return type;
}

export function parseDeviceConfigJson(json: string): BridgeDevice[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("DEVICE_CONFIG_JSON must be valid JSON.");
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("DEVICE_CONFIG_JSON must be a JSON array with at least one device.");
  }

  const devices = parsed.map((entry, index) => {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Device ${index + 1} must be a JSON object.`);
    }

    const rawDevice = entry as RawBridgeDevice;
    const id = readString(rawDevice.id, "id", index);
    const localId = readOptionalString(rawDevice.localId, "localId", index) ?? id;
    const name = readString(rawDevice.name, "name", index);

    return {
      id,
      localId,
      name,
      nicknames: readNicknames(rawDevice.nicknames, index),
      roomHint: readOptionalString(rawDevice.roomHint, "roomHint", index),
      type: readDeviceType(rawDevice.type, index),
    } satisfies BridgeDevice;
  });

  const seenIds = new Set<string>();
  const seenLocalIds = new Set<string>();

  for (const device of devices) {
    if (seenIds.has(device.id)) {
      throw new Error(`Duplicate device id "${device.id}" in DEVICE_CONFIG_JSON.`);
    }
    if (seenLocalIds.has(device.localId)) {
      throw new Error(`Duplicate localId "${device.localId}" in DEVICE_CONFIG_JSON.`);
    }

    seenIds.add(device.id);
    seenLocalIds.add(device.localId);
  }

  return devices;
}
