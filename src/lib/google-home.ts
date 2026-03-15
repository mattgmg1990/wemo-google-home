import { configuredDevices, type BridgeDevice } from "@/lib/bridge-devices";
import { getLocalDevices, type LocalApiDevice, setLocalDevice } from "@/lib/device-api";
import { googleAgentUserId } from "@/lib/env";

type IntentRequest = {
  inputs?: Array<{
    payload?: {
      commands?: Array<{
        devices?: Array<{ id?: string }>;
        execution?: Array<{
          command?: string;
          params?: {
            on?: boolean;
          };
        }>;
        executions?: Array<{
          command?: string;
          params?: {
            on?: boolean;
          };
        }>;
      }>;
      devices?: Array<{ id?: string }>;
    };
  }>;
  requestId?: string;
};

type DeviceStatePayload = Record<
  string,
  {
    on: boolean;
    online: boolean;
  }
>;

type KnownDeviceState = {
  online: boolean;
  on: boolean;
  updatedAt: number;
};

type DeviceCatalog = {
  deviceById: Map<string, BridgeDevice>;
  deviceByLocalId: Map<string, BridgeDevice>;
  devices: BridgeDevice[];
};

let lastKnownStates: Record<string, KnownDeviceState> = {};
let backgroundRefreshInFlight = false;

function deviceCatalog(): DeviceCatalog {
  const devices = configuredDevices();

  return {
    deviceById: new Map(devices.map((device) => [device.id, device])),
    deviceByLocalId: new Map(devices.map((device) => [device.localId, device])),
    devices,
  };
}

function executionsForCommand(
  command:
    | {
        execution?: Array<{
          command?: string;
          params?: {
            on?: boolean;
          };
        }>;
        executions?: Array<{
          command?: string;
          params?: {
            on?: boolean;
          };
        }>;
      }
    | undefined,
) {
  return command?.execution ?? command?.executions ?? [];
}

function rememberDeviceState(googleId: string, on: boolean, online: boolean) {
  lastKnownStates = {
    ...lastKnownStates,
    [googleId]: {
      on,
      online,
      updatedAt: Date.now(),
    },
  };
}

function rememberStatesFromLocalDevices(devices: LocalApiDevice[], catalog: DeviceCatalog) {
  for (const device of devices) {
    const bridgeDevice = catalog.deviceByLocalId.get(device.id);
    if (!bridgeDevice) {
      continue;
    }

    rememberDeviceState(bridgeDevice.id, device.state === "on", device.online ?? true);
  }
}

function allKnownDeviceIds(catalog: DeviceCatalog) {
  return catalog.devices.map((device) => device.id);
}

function requestedQueryDeviceIds(request: IntentRequest): string[] {
  return (
    request.inputs?.flatMap((input) =>
      input.payload?.devices?.flatMap((device) => (device.id ? [device.id] : [])) ?? [],
    ) ?? []
  );
}

function requestedExecutionDeviceIds(request: IntentRequest): string[] {
  return (
    request.inputs?.flatMap((input) =>
      input.payload?.commands?.flatMap((command) =>
        command.devices?.flatMap((device) => (device.id ? [device.id] : [])) ?? [],
      ) ?? [],
    ) ?? []
  );
}

function fallbackDeviceIds(deviceIds: string[], catalog: DeviceCatalog): string[] {
  return deviceIds.length > 0 ? deviceIds : allKnownDeviceIds(catalog);
}

function requestedOnState(request: IntentRequest): boolean | null {
  const inputs = request.inputs ?? [];

  for (const input of inputs) {
    for (const command of input.payload?.commands ?? []) {
      for (const execution of executionsForCommand(command)) {
        const commandName = execution.command?.toLowerCase() ?? "";

        if (commandName.includes("onoff_on")) {
          return true;
        }

        if (commandName.includes("onoff_off")) {
          return false;
        }

        if (typeof execution.command === "string" && commandName.includes("onoff")) {
          if (typeof execution.params?.on === "boolean") {
            return execution.params.on;
          }

          if (execution.params != null) {
            for (const value of Object.values(execution.params)) {
              if (typeof value === "boolean") {
                return value;
              }
            }
          }
        }

        const serializedExecution = JSON.stringify(execution);
        if (serializedExecution.includes("ONOFF_ON")) {
          return true;
        }

        if (serializedExecution.includes("ONOFF_OFF")) {
          return false;
        }
      }
    }
  }

  return null;
}

function deviceStatePayload(deviceIds: string[]): DeviceStatePayload {
  return Object.fromEntries(
    deviceIds.map((deviceId) => {
      const state = lastKnownStates[deviceId] ?? {
        on: false,
        online: false,
      };

      return [
        deviceId,
        {
          on: state.on,
          online: state.online,
        },
      ];
    }),
  );
}

function refreshDeviceStatesInBackground() {
  if (backgroundRefreshInFlight) {
    return;
  }

  backgroundRefreshInFlight = true;
  void getLocalDevices()
    .then((devices) => {
      rememberStatesFromLocalDevices(devices, deviceCatalog());
      console.info("[fulfillment] background refresh updated states", {
        devices: devices.map((device) => ({
          id: device.id,
          name: device.name,
          online: device.online ?? true,
          state: device.state,
        })),
      });
    })
    .catch((error) => {
      console.warn("[fulfillment] background refresh failed", {
        error: error instanceof Error ? error.message : "unknown error",
      });
    })
    .finally(() => {
      backgroundRefreshInFlight = false;
    });
}

function missingKnownState(deviceIds: string[]) {
  return deviceIds.some((deviceId) => lastKnownStates[deviceId] == null);
}

export function syncPayload(requestId: string) {
  const catalog = deviceCatalog();

  return {
    requestId,
    payload: {
      agentUserId: googleAgentUserId(),
      devices: catalog.devices.map((device) => ({
        id: device.id,
        type: device.type,
        traits: ["action.devices.traits.OnOff"],
        name: {
          defaultNames: [device.name],
          name: device.name,
          nicknames: device.nicknames,
        },
        willReportState: false,
        attributes: {},
        deviceInfo: {
          manufacturer: "Self-hosted bridge",
          model: "WeMo bridge",
        },
        ...(device.roomHint ? { roomHint: device.roomHint } : {}),
      })),
    },
  };
}

export async function queryPayload(request: IntentRequest) {
  const catalog = deviceCatalog();
  const requestId = request.requestId ?? "";
  const responseDeviceIds = fallbackDeviceIds(requestedQueryDeviceIds(request), catalog);

  if (!missingKnownState(responseDeviceIds)) {
    console.info("[fulfillment] query served from last-known states", {
      requestId,
      responseDeviceIds,
    });
    refreshDeviceStatesInBackground();

    return {
      requestId,
      payload: {
        devices: deviceStatePayload(responseDeviceIds),
      },
    };
  }

  try {
    const devices = await getLocalDevices();
    rememberStatesFromLocalDevices(devices, catalog);
    console.info("[fulfillment] query result", {
      devices: devices.map((device) => ({
        id: device.id,
        name: device.name,
        online: device.online ?? true,
        state: device.state,
      })),
      requestId,
      responseDeviceIds,
    });

    return {
      requestId,
      payload: {
        devices: deviceStatePayload(responseDeviceIds),
      },
    };
  } catch (error) {
    console.error("[fulfillment] query failed", {
      error: error instanceof Error ? error.message : "unknown error",
      requestId,
      responseDeviceIds,
      fallbackStates: deviceStatePayload(responseDeviceIds),
    });

    return {
      requestId,
      payload: {
        devices: deviceStatePayload(responseDeviceIds),
      },
    };
  }
}

export async function executePayload(request: IntentRequest) {
  const catalog = deviceCatalog();
  const requestId = request.requestId ?? "";
  const commands = request.inputs?.[0]?.payload?.commands ?? [];
  const responseDeviceIds = fallbackDeviceIds(requestedExecutionDeviceIds(request), catalog);
  const desiredState = requestedOnState(request);
  const targetDevices = responseDeviceIds
    .map((deviceId) => catalog.deviceById.get(deviceId))
    .filter((device): device is BridgeDevice => device != null);

  console.info("[fulfillment] execute request", {
    desiredState,
    requestId,
    commands: commands.map((command) => ({
      deviceIds: command.devices?.map((device) => device.id ?? "<missing-id>") ?? [],
      executions: executionsForCommand(command).map((execution) => ({
        command: execution.command ?? "<missing-command>",
        on: execution.params?.on,
      })),
    })),
    responseDeviceIds,
  });

  if (desiredState === null) {
    console.warn("[fulfillment] execute rejected: unsupported command", { requestId });
    return {
      requestId,
      payload: {
        commands: [
          {
            ids: responseDeviceIds,
            status: "ERROR",
            errorCode: "functionNotSupported",
          },
        ],
      },
    };
  }

  if (targetDevices.length !== responseDeviceIds.length) {
    console.warn("[fulfillment] execute rejected: unknown device id", {
      requestId,
      responseDeviceIds,
    });
    return {
      requestId,
      payload: {
        commands: [
          {
            ids: responseDeviceIds,
            status: "ERROR",
            errorCode: "deviceNotFound",
          },
        ],
      },
    };
  }

  try {
    const updatedDevices = await Promise.all(
      targetDevices.map((device) => setLocalDevice(device.localId, desiredState ? "on" : "off")),
    );
    rememberStatesFromLocalDevices(updatedDevices, catalog);
    console.info("[fulfillment] execute result", {
      desiredState,
      devices: updatedDevices.map((device) => ({
        id: device.id,
        name: device.name,
        online: device.online ?? true,
        state: device.state,
      })),
      requestId,
      responseDeviceIds,
    });

    return {
      requestId,
      payload: {
        commands: [
          {
            ids: responseDeviceIds,
            status: "SUCCESS",
            states: {
              on: desiredState,
              online: true,
            },
          },
        ],
      },
    };
  } catch (error) {
    for (const device of targetDevices) {
      rememberDeviceState(device.id, desiredState, false);
    }

    console.error("[fulfillment] execute failed", {
      desiredState,
      error: error instanceof Error ? error.message : "unknown error",
      requestId,
      responseDeviceIds,
    });

    return {
      requestId,
      payload: {
        commands: [
          {
            ids: responseDeviceIds,
            status: "ERROR",
            errorCode: "deviceOffline",
          },
        ],
      },
    };
  }
}
